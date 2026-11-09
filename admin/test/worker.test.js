import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';
import { appJwt, decodeContent, encodeContent } from '../src/github.js';
import { parseContent, findProject, updateProject, createProject } from '../src/content.js';
import { createWorker } from '../src/worker.js';

const source = readFileSync(new URL('../../content/home.json', import.meta.url), 'utf8');
const id = 'stm32-beginner-resources';
const sha = 'a'.repeat(40);
const nextSha = 'b'.repeat(40);
const commitSha = 'c'.repeat(40);
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const env = {
    GITHUB_APP_ID: '123',
    GITHUB_INSTALLATION_ID: '456',
    GITHUB_OWNER: 'Gadel-Hub',
    GITHUB_REPO: 'gadelhub-dot-com',
    GITHUB_PRIVATE_KEY: key.export({ type: 'pkcs8', format: 'pem' }),
};
const project = findProject(parseContent(source), id);
const edit = () => ({
    sha,
    title: { tr: project.title.tr, en: 'Updated STM32 resources' },
    description: { ...project.description },
});
const file = () => ({ type: 'file', encoding: 'base64', sha, content: encodeContent(source) });
const reply = (body, status = 200, headers) => Response.json(body, { status, headers });
function request(method = 'GET', body, path = `/api/projects/${id}`, extra = {}) {
    return new Request(`http://localhost${path}`, {
        method,
        headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', ...extra },
        ...(body === undefined
            ? {}
            : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
}
function mockGithub({
    content = file(),
    putStatus = 200,
    loadStatus = 200,
    tokenStatus = 200,
} = {}) {
    const calls = [];
    const fetcher = async (url, options) => {
        calls.push({ url, ...options });
        if (url.includes('/access_tokens'))
            return reply(
                { token: 'test-installation-token', expires_at: '2099-01-01T00:00:00Z' },
                tokenStatus,
            );
        if (options.method === 'PUT')
            return reply({ content: { sha: nextSha }, commit: { sha: commitSha } }, putStatus);
        return reply(content, loadStatus);
    };
    return { worker: createWorker(fetcher), calls };
}

test('GitHub UTF-8 decoding and source structure validation', () => {
    assert.equal(decodeContent(encodeContent(source)), source);
    assert.equal(decodeContent(`\n${encodeContent('Türkçe 🎮')}\n`), 'Türkçe 🎮');
    for (const input of ['!!!', '/w==', null]) assert.throws(() => decodeContent(input));
    assert.throws(() => parseContent('{}'));
    assert.throws(() => parseContent('not json'));
    assert.equal(findProject(parseContent(source), 'game-development-area').verified, false);
    assert.equal(project.id, id);
});

test('JWT signs and verifies PKCS#8 and GitHub PKCS#1 with bounded claims', async () => {
    for (const type of ['pkcs8', 'pkcs1']) {
        const jwt = await appJwt(
            { ...env, GITHUB_PRIVATE_KEY: key.export({ type, format: 'pem' }) },
            1000,
        );
        const [header, payload, signature] = jwt.split('.');
        assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), {
            alg: 'RS256',
            typ: 'JWT',
        });
        assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), {
            iat: 940,
            exp: 1540,
            iss: '123',
        });
        assert(
            verify(
                'RSA-SHA256',
                Buffer.from(`${header}.${payload}`),
                createPublicKey(key),
                Buffer.from(signature, 'base64url'),
            ),
        );
    }
});

test('allowlisted edits are deterministic and preserve all unrelated bytes and records', () => {
    const body = edit();
    body.title.en = 'Quoted "title" \\ MCU 🎮';
    const updated = updateProject(source, id, body);
    assert.equal(
        updated.text,
        source.replace(JSON.stringify(project.title.en), JSON.stringify(body.title.en)),
    );
    assert.equal(updateProject(source, id, body).text, updated.text);
    assert.equal(updateProject(updated.text, id, body).text, updated.text);
    const before = JSON.parse(source),
        after = JSON.parse(updated.text);
    after.projects[1].title.en = before.projects[1].title.en;
    assert.deepEqual(after, before);
    assert(updated.text.endsWith('\n'));
    assert.equal(
        updateProject(source, id, { sha, title: project.title, description: project.description })
            .text,
        source,
    );
});

test('reject extra fields, missing languages, wrong types, blank and oversized text', () => {
    const invalid = [
        { ...edit(), id: 'changed' },
        { ...edit(), path: 'README.md' },
        { ...edit(), title: { ...edit().title, fr: 'extra' } },
        { ...edit(), title: { en: 'Only English' } },
        { ...edit(), description: { tr: 1, en: 'Valid' } },
        { ...edit(), title: { tr: ' ', en: 'Valid' } },
        { ...edit(), title: { tr: 'Valid', en: 'x'.repeat(161) } },
        { ...edit(), description: { tr: 'x'.repeat(2001), en: 'Valid' } },
        { ...edit(), sha: 'bad' },
    ];
    for (const body of invalid)
        assert.throws(() => updateProject(source, id, body), { status: 422 });
});

test('list and load expose all projects/editor data and file SHA', async () => {
    for (const path of ['/api/projects', `/api/projects/${id}`]) {
        const { worker, calls } = mockGithub();
        const response = await worker.fetch(request('GET', undefined, path), env);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.sha, sha);
        assert.equal((body.project || body.projects.find((p) => p.id === id)).id, id);
        if (body.projects) assert.equal(body.projects.length, 2);
        assert(!JSON.stringify(body).includes('token'));
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert(calls[1].url.endsWith('?ref=main'));
        const tokenRequest = JSON.parse(calls[0].body);
        assert.deepEqual(tokenRequest, {
            repositories: ['gadelhub-dot-com'],
            permissions: { contents: 'write' },
        });
    }
});

test('successful publish performs exactly one atomic fixed-path Contents write', async () => {
    const { worker, calls } = mockGithub();
    const response = await worker.fetch(request('PUT', edit()), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).commitSha, commitSha);
    const writes = calls.filter((call) => call.method === 'PUT');
    assert.equal(writes.length, 1);
    assert.equal(
        writes[0].url,
        'https://api.github.com/repos/Gadel-Hub/gadelhub-dot-com/contents/content/home.json',
    );
    const body = JSON.parse(writes[0].body);
    assert.equal(body.sha, sha);
    assert.equal(body.branch, 'main');
    assert.equal(body.message, `content: update ${id}`);
    assert.equal(
        decodeContent(body.content),
        source.replace(JSON.stringify(project.title.en), JSON.stringify(edit().title.en)),
    );
    assert.equal(writes[0].headers.Authorization, 'Bearer test-installation-token');
});

test('stale loaded SHA and race during GitHub update both return 409; no retry', async () => {
    const first = mockGithub();
    assert.equal(
        (await first.worker.fetch(request('PUT', { ...edit(), sha: nextSha }), env)).status,
        409,
    );
    assert.equal(first.calls.filter((call) => call.method === 'PUT').length, 0);
    for (const putStatus of [409, 422]) {
        const { worker, calls } = mockGithub({ putStatus });
        assert.equal((await worker.fetch(request('PUT', edit()), env)).status, 409);
        assert.equal(calls.filter((call) => call.method === 'PUT').length, 1);
    }
});

test('unchanged fields create no commit', async () => {
    const { worker, calls } = mockGithub();
    const response = await worker.fetch(
        request('PUT', { sha, title: project.title, description: project.description }),
        env,
    );
    assert.equal((await response.json()).unchanged, true);
    assert.equal(calls.length, 2);
});

test('GitHub authentication/not-found/API/malformed/network failures remain sanitized', async () => {
    for (const options of [
        { tokenStatus: 401 },
        { loadStatus: 404 },
        { loadStatus: 403 },
        { loadStatus: 500 },
        { loadStatus: 429 },
        { content: {} },
        { content: null },
        { content: { ...file(), content: '!!!' } },
    ]) {
        const { worker } = mockGithub(options);
        const response = await worker.fetch(request(), env);
        assert(response.status >= 500);
        const body = await response.text();
        assert(!body.includes('test-installation-token'));
        assert(!body.includes('PRIVATE KEY'));
    }
    const worker = createWorker(async () => {
        throw new Error('secret raw failure');
    });
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 502);
    assert(!String(await response.text()).includes('secret raw failure'));
    assert.equal((await createWorker().fetch(request(), {})).status, 503);
});

test('API rejects methods, bad IDs, content types, cross-origin and oversized bodies before GitHub', async () => {
    let calls = 0;
    const worker = createWorker(async () => {
        calls++;
        throw new Error();
    });
    const cases = [
        [request('POST', {}), 405],
        [request('PUT', edit(), '/api/projects'), 405],
        [request('GET', undefined, '/api/projects/bad_id'), 404],
        [request('PUT', edit(), undefined, { Origin: 'https://other.example' }), 403],
        [request('PUT', edit(), undefined, { 'Content-Type': 'text/plain' }), 415],
        [request('PUT', 'x'.repeat(20001)), 413],
        [request('PUT', '{broken'), 400],
        [request('PUT', { ...edit(), owner: 'attacker' }), 422],
    ];
    for (const [req, status] of cases) assert.equal((await worker.fetch(req, env)).status, status);
    assert.equal(calls, 0);
});

test('mock mode simulates editing without ANY GitHub calls and refuses nonlocal hosts', async () => {
    const worker = createWorker(async () => {
        throw new Error('must never call GitHub');
    });
    const mockEnv = { MOCK_MODE: 'true' };
    const response = await worker.fetch(
        request('PUT', { ...edit(), sha: '0'.repeat(40) }),
        mockEnv,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.mode, 'mock');
    assert.equal(body.commitSha, null);
    assert.equal(body.project.title.en, edit().title.en);
    assert.equal(
        (await worker.fetch(new Request('https://admin.gadelhub.com/api/projects'), mockEnv))
            .status,
        503,
    );
    const reload = await (await worker.fetch(request(), mockEnv)).json();
    assert.equal(reload.project.title.en, edit().title.en);
});

test('static assets are served through Worker with security headers and method restrictions', async () => {
    const worker = createWorker();
    const assets = {
        ASSETS: {
            fetch: async () =>
                new Response('editor html', { headers: { 'Content-Type': 'text/html' } }),
        },
    };
    const response = await worker.fetch(new Request('http://localhost/'), assets);
    assert.equal(await response.text(), 'editor html');
    assert(response.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    assert.equal(
        (await worker.fetch(new Request('http://localhost/', { method: 'POST' }), assets)).status,
        405,
    );
});

test('unknown project cannot publish', async () => {
    for (const otherId of ['missing-project']) {
        const { worker, calls } = mockGithub();
        assert.equal(
            (await worker.fetch(request('PUT', edit(), `/api/projects/${otherId}`), env)).status,
            404,
        );
        assert.equal(calls.filter((call) => call.method === 'PUT').length, 0);
    }
});

test('write network ambiguity, malformed success and rate limit produce useful errors without retry', async () => {
    for (const failure of ['network', 'malformed', 'rate']) {
        let writes = 0;
        const worker = createWorker(async (url, options) => {
            if (options.method !== 'PUT')
                return url.includes('/access_tokens')
                    ? reply({ token: 'test-token', expires_at: '2099-01-01T00:00:00Z' })
                    : reply(file());
            writes++;
            if (failure === 'network') throw new Error('private transport internals');
            if (failure === 'malformed') return reply({});
            return reply({}, 403, { 'x-ratelimit-remaining': '0' });
        });
        const response = await worker.fetch(request('PUT', edit()), env);
        assert.equal(response.status, failure === 'rate' ? 503 : 502);
        const body = await response.json();
        assert.equal(
            body.error.code,
            {
                network: 'publish_unknown',
                malformed: 'invalid_github_response',
                rate: 'github_rate_limit',
            }[failure],
        );
        assert.equal(writes, 1);
        assert(!JSON.stringify(body).includes('private transport'));
    }
});

test('installation token responses are validated and credentials are never reflected', async () => {
    for (const body of [
        null,
        { token: '', expires_at: '2099-01-01' },
        { token: 'private-token', expires_at: '2000-01-01' },
        { token: 'private-token' },
    ]) {
        const worker = createWorker(async () => reply(body));
        const response = await worker.fetch(request(), env);
        assert.equal(response.status, 502);
        assert(!String(await response.text()).includes('private-token'));
    }
});

test('edits preserve reordered language keys and untouched escaped string tokens', () => {
    const data = JSON.parse(source);
    data.projects[1].title = { en: project.title.en, tr: project.title.tr };
    const text =
        JSON.stringify(data, null, 2).replace('STM32 Başlangıç', 'STM32 Ba\\u015flangıç') + '\n';
    const updated = updateProject(text, id, edit());
    assert.equal(
        updated.text,
        text.replace(JSON.stringify(project.title.en), JSON.stringify(edit().title.en)),
    );
});

const creation = () => ({
    ...edit(),
    id: 'test-project',
    domain: 'game-development',
    verified: false,
    archived: true,
});

test('create commits one structured record atomically and preserves all other source bytes', async () => {
    const body = creation();
    const updated = createProject(source, body);
    const before = JSON.parse(source),
        after = JSON.parse(updated.text);
    assert.deepEqual(after.projects.pop(), {
        id: body.id,
        verified: false,
        domain: body.domain,
        symbol: '✦',
        title: body.title,
        description: body.description,
        archived: true,
    });
    assert.deepEqual(after, before);
    const start = source.indexOf('"projects"'),
        end = source.indexOf('"week"');
    assert.equal(updated.text.slice(0, start), source.slice(0, start));
    assert.equal(updated.text.slice(updated.text.indexOf('"week"')), source.slice(end));
    for (const record of before.projects)
        assert(
            updated.text.includes(JSON.stringify(record.title)) ||
                updated.text.includes(JSON.stringify(record.title.tr)),
        ); // original records remain intact
    const { worker, calls } = mockGithub();
    const response = await worker.fetch(request('POST', body, '/api/projects'), env);
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.project.id, body.id);
    const writes = calls.filter((call) => call.method === 'PUT');
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(writes[0].body).sha, sha);
    assert.equal(decodeContent(JSON.parse(writes[0].body).content), updated.text);
});

test('creation rejects duplicate IDs globally, invalid IDs, domains, flags, translations and unknown fields', async () => {
    const invalid = [
        { ...creation(), id },
        { ...creation(), id: 'godot-docs' },
        { ...creation(), id: 'Bad_ID' },
        { ...creation(), id: 'bad--id' },
        { ...creation(), id: 'x'.repeat(101) },
        { ...creation(), title: { tr: 'TR only' } },
        { ...creation(), description: { tr: 'TR', en: ' ' } },
        { ...creation(), domain: 'Electronics' },
        { ...creation(), verified: 'true' },
        { ...creation(), archived: null },
        { ...creation(), symbol: 'changed' },
        { ...creation(), title: { tr: 'TR', en: 'EN', fr: 'FR' } },
        { ...creation(), path: 'other.json' },
    ];
    for (const body of invalid) {
        const { worker, calls } = mockGithub();
        assert.equal((await worker.fetch(request('POST', body, '/api/projects'), env)).status, 422);
        assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
    }
    const { worker, calls } = mockGithub();
    assert.equal(
        (await worker.fetch(request('POST', { ...creation(), sha: nextSha }, '/api/projects'), env))
            .status,
        409,
    );
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
});

test('archive and restore preserve verification, identity, symbol, extra metadata and unrelated JSON', () => {
    const data = JSON.parse(source);
    data.projects[1].future_metadata = { keep: 'intact' };
    const text = JSON.stringify(data, null, 2) + '\n';
    const result = updateProject(text, id, {
        ...edit(),
        domain: 'game-development',
        verified: false,
        archived: true,
    });
    const updated = JSON.parse(result.text);
    assert.equal(updated.projects[1].archived, true);
    assert.equal(updated.projects[1].verified, false);
    assert.equal(updated.projects[1].symbol, project.symbol);
    assert.deepEqual(updated.projects[1].future_metadata, { keep: 'intact' });
    assert.deepEqual(updated.week, data.week);
    assert.deepEqual(updated.events, data.events);
    assert.deepEqual(updated.teams, data.teams);
    assert.deepEqual(updated.featured, data.featured);
    assert.deepEqual(updated.projects[0], data.projects[0]);
    const restored = updateProject(result.text, id, { ...edit(), archived: false, verified: true });
    assert.equal(restored.project.archived, false);
    assert.equal(restored.project.verified, true);
    for (const field of [
        { id: 'new-id' },
        { symbol: 'new' },
        { verified: 1 },
        { archived: 'yes' },
        { domain: 'unknown' },
    ])
        assert.throws(() => updateProject(source, id, { ...edit(), ...field }), { status: 422 });
});

test('mock supports list/create/edit/archive/reload and stale-SHA conflicts without GitHub calls', async () => {
    const worker = createWorker(() => {
            throw new Error('GitHub forbidden');
        }),
        mock = { MOCK_MODE: 'true' };
    let listing = await (
        await worker.fetch(request('GET', undefined, '/api/projects'), mock)
    ).json();
    const created = await worker.fetch(
        request('POST', { ...creation(), sha: listing.sha }, '/api/projects'),
        mock,
    );
    assert.equal(created.status, 201);
    const first = await created.json();
    assert.equal(first.commitSha, null);
    assert.notEqual(first.sha, listing.sha);
    const stale = await worker.fetch(
        request(
            'PUT',
            { ...edit(), sha: listing.sha, archived: true },
            `/api/projects/${first.project.id}`,
        ),
        mock,
    );
    assert.equal(stale.status, 409);
    const saved = await worker.fetch(
        request(
            'PUT',
            { ...edit(), sha: first.sha, archived: false, verified: true },
            `/api/projects/${first.project.id}`,
        ),
        mock,
    );
    const second = await saved.json();
    assert.equal(saved.status, 200);
    const hidden = await worker.fetch(
        request(
            'PUT',
            { ...edit(), sha: second.sha, archived: true },
            `/api/projects/${first.project.id}`,
        ),
        mock,
    );
    assert.equal(hidden.status, 200);
    listing = await (await worker.fetch(request('GET', undefined, '/api/projects'), mock)).json();
    assert.equal(listing.projects.length, 3);
    assert.equal(listing.projects.find((p) => p.id === first.project.id).archived, true);
    const reloaded = await (
        await worker.fetch(request('GET', undefined, `/api/projects/${first.project.id}`), mock)
    ).json();
    assert.equal(reloaded.project.verified, true);
    assert.equal(reloaded.project.archived, true);
    assert.equal(
        (await worker.fetch(request('DELETE', undefined, `/api/projects/${id}`), mock)).status,
        405,
    );
});

test('POST has the same origin, JSON, byte-stream and content-length protections as PUT', async () => {
    const { worker, calls } = mockGithub();
    const cases = [
        [request('POST', creation(), '/api/projects', { 'Content-Type': 'text/plain' }), 415],
        [request('POST', creation(), '/api/projects', { Origin: 'https://foreign.example' }), 403],
        [request('POST', creation(), '/api/projects', { 'Sec-Fetch-Site': 'cross-site' }), 403],
        [request('POST', 'x'.repeat(20001), '/api/projects'), 413],
        [request('POST', creation(), '/api/projects', { 'Content-Length': '20001' }), 413],
        [request('POST', '{broken', '/api/projects'), 400],
        [request('POST', undefined, '/api/projects'), 400],
    ];
    for (const [req, status] of cases) assert.equal((await worker.fetch(req, env)).status, status);
    assert.equal(calls.length, 0);
});

test('creation bootstraps an empty catalog and keeps UTF-8/localized source valid', () => {
    const data = JSON.parse(source);
    data.projects = [];
    const text = JSON.stringify(data, null, 2) + '\n';
    const result = createProject(text, {
        ...creation(),
        title: { tr: 'Türkçe "başlık" 🎮', en: 'Quoted "title"' },
    });
    const updated = JSON.parse(result.text);
    assert.equal(updated.projects.length, 1);
    assert.equal(updated.projects[0].id, creation().id);
    updated.projects = [];
    assert.deepEqual(updated, data);
});
