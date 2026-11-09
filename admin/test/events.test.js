import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { createWorker } from '../src/worker.js';
import { encodeContent, decodeContent } from '../src/github.js';
import { createEvent, updateEvent, validateEventWrite } from '../src/events.js';
import { eventInstant, validEventDate, sortEvents } from '../public/event-fields.js';

const original = readFileSync(new URL('../../content/home.json', import.meta.url), 'utf8');
const sha = 'a'.repeat(40),
    nextSha = 'b'.repeat(40);
const external = {
    candidate_id: 'gamejam:test@gamejam.gg',
    source_name: 'gamejam.gg',
    source_id: 'test',
    source_url: 'https://gamejam.gg/jam/test',
    attribution: { label: 'gamejam.gg', url: 'https://gamejam.gg/', active_link_required: true },
    platforms: [],
    end_at: '2027-11-22T12:00:00+00:00',
};
const event = {
    id: 'reviewed-jam',
    date: '2027-11-21T16:00:00+03:00',
    location: 'Online / GTÜ',
    title: { tr: 'Onaylı oyun maratonu', en: 'Reviewed game jam' },
    description: { tr: 'İnsan tarafından onaylı metin.', en: 'Human-reviewed editorial text.' },
    external,
};
const data = JSON.parse(original);
data.events.items = [event];
const source = JSON.stringify(data, null, 2) + '\n';
const body = () => ({
    sha,
    date: event.date,
    location: event.location,
    title: { ...event.title },
    description: { ...event.description },
});
const creation = () => ({ ...body(), id: 'manual-event' });
const request = (method = 'GET', body, path = '/api/events', headers = {}) =>
    new Request(`http://localhost${path}`, {
        method,
        headers: { Origin: 'http://localhost', 'Content-Type': 'application/json', ...headers },
        ...(body === undefined
            ? {}
            : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
const env = {
    GITHUB_APP_ID: '123',
    GITHUB_INSTALLATION_ID: '456',
    GITHUB_OWNER: 'Gadel-Hub',
    GITHUB_REPO: 'gadelhub-dot-com',
    GITHUB_PRIVATE_KEY: key.export({ type: 'pkcs8', format: 'pem' }),
};
function github({ putStatus = 200, text = source } = {}) {
    const calls = [];
    const worker = createWorker(async (url, options) => {
        calls.push({ url, ...options });
        return Response.json(
            url.includes('/access_tokens')
                ? { token: 'private-test-token', expires_at: '2099-01-01T00:00:00Z' }
                : options.method === 'PUT'
                  ? { commit: { sha: 'c'.repeat(40) }, content: { sha: nextSha } }
                  : { type: 'file', encoding: 'base64', sha, content: encodeContent(text) },
            { status: options.method === 'PUT' ? putStatus : 200 },
        );
    });
    return { worker, calls };
}

test('event date validation checks calendar, leap year, explicit offsets and preserves exact instants', () => {
    for (const date of [
        '2028-02-29T23:59:59.123456+03:00',
        '2027-01-01T00:00:00Z',
        '2027-01-01 00:00+00:00',
        '0001-01-01T00:00:00+00:00',
    ])
        assert(validEventDate(date), date);
    for (const date of [
        '2026-02-29T12:00:00Z',
        '2027-02-30T12:00:00Z',
        '2027-13-01T12:00:00Z',
        '2027-01-00T12:00:00Z',
        '2027-01-01',
        '2027-01-01T12:00:00',
        '2027-01-01T24:00:00Z',
        '2027-01-01T12:60:00Z',
        '2027-01-01T12:00:60Z',
        '2027-01-01T12:00:00+24:00',
        'not a date',
        null,
    ])
        assert(!validEventDate(date), String(date));
    assert.equal(eventInstant('2027-11-21T16:00:00+03:00'), Date.parse('2027-11-21T13:00:00Z'));
});

test('event listing and detail expose provenance without sorting the source', async () => {
    const { worker, calls } = github();
    const listing = await worker.fetch(request(), env);
    assert.equal(listing.status, 200);
    const result = await listing.json();
    assert.equal(result.events.length, 1);
    assert.equal(result.sha, sha);
    assert.deepEqual(result.events[0].external, external);
    assert.equal(result.events[0].archived, false);
    const detail = await (
        await worker.fetch(request('GET', undefined, '/api/events/reviewed-jam'), env)
    ).json();
    assert.equal(detail.event.date, event.date);
    assert(calls.some((c) => c.url.endsWith('?ref=main')));
    assert(!JSON.stringify(result).includes('private-test-token'));
});

test('event creation is one SHA-guarded fixed-path commit, archived by default, with no fabricated provenance', async () => {
    const { worker, calls } = github();
    const response = await worker.fetch(request('POST', creation()), env);
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.event.archived, true);
    assert.equal(result.event.external, undefined);
    assert.equal(result.event.date, event.date);
    const writes = calls.filter((c) => c.method === 'PUT');
    assert.equal(writes.length, 1);
    assert(writes[0].url.endsWith('/contents/content/home.json'));
    const write = JSON.parse(writes[0].body);
    assert.equal(write.sha, sha);
    assert.equal(write.branch, 'main');
    const after = JSON.parse(decodeContent(write.content));
    assert.equal(after.events.items.pop().id, 'manual-event');
    assert.deepEqual(after, data);
});

test('duplicate IDs across events, projects and other content are rejected before write', async () => {
    for (const id of [
        'reviewed-jam',
        'stm32-beginner-resources',
        'upcoming-events',
        'godot-docs',
    ]) {
        const { worker, calls } = github();
        assert.equal((await worker.fetch(request('POST', { ...creation(), id }), env)).status, 422);
        assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
    }
});

test('exact event write schema rejects invalid IDs, date, translations, location, flags and unknown fields', async () => {
    const cases = [
        { id: 'Bad_ID' },
        { id: 'bad--id' },
        { id: 'x'.repeat(101) },
        { date: '2027-02-30T12:00:00Z' },
        { date: '2027-02-21' },
        { date: '2027-02-21T12:00:00' },
        { title: { tr: 'Only TR' } },
        { description: { tr: 'TR', en: '' } },
        { location: '' },
        { location: { tr: 'GTÜ', en: 'GTU' } },
        { archived: 'false' },
        { verified: true },
        { external },
        { url: 'https://example.org/' },
        { path: 'other.json' },
        { title: { tr: 'TR', en: 'EN', fr: 'FR' } },
    ];
    for (const change of cases) {
        const { worker, calls } = github();
        assert.equal(
            (await worker.fetch(request('POST', { ...creation(), ...change }), env)).status,
            422,
            JSON.stringify(change),
        );
        assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
    }
    for (const key of ['date', 'location', 'title', 'description', 'id']) {
        const value = creation();
        delete value[key];
        assert.throws(() => validateEventWrite(value, true), { status: 422 });
    }
    assert.throws(() => updateEvent(source, event.id, { ...body(), id: 'rename' }), {
        status: 422,
    });
});

test('archive/restore and localized edits preserve offset, provenance, future metadata and unrelated source bytes', () => {
    const extra = JSON.parse(source);
    extra.events.items[0].future_metadata = { keep: 'intact' };
    const text = JSON.stringify(extra, null, 2) + '\n';
    const updated = updateEvent(text, event.id, {
        ...body(),
        title: { ...event.title, en: 'Updated <event>' },
        archived: true,
    });
    assert.equal(updated.event.archived, true);
    assert.equal(updated.event.date, event.date);
    assert.deepEqual(updated.event.external, external);
    const after = JSON.parse(updated.text);
    assert.deepEqual(after.events.items[0].future_metadata, { keep: 'intact' });
    after.events.items[0].title.en = event.title.en;
    delete after.events.items[0].archived;
    assert.deepEqual(after, extra);
    assert.equal(
        updated.text.slice(0, updated.text.indexOf('"events"')),
        text.slice(0, text.indexOf('"events"')),
    );
    assert.equal(
        updated.text.slice(updated.text.indexOf('"teams"')),
        text.slice(text.indexOf('"teams"')),
    );
    const restored = updateEvent(updated.text, event.id, { ...body(), archived: false });
    assert.equal(restored.event.archived, false);
    assert.equal(updateEvent(source, event.id, body()).text, source);
    assert.throws(() => updateEvent(source, event.id, { ...body(), external: {} }), {
        status: 422,
    });
});

test('stale event SHA and GitHub write races return 409 without retries', async () => {
    const { worker, calls } = github();
    assert.equal(
        (
            await worker.fetch(
                request('PUT', { ...body(), sha: nextSha }, '/api/events/reviewed-jam'),
                env,
            )
        ).status,
        409,
    );
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
    for (const putStatus of [409, 422]) {
        const { worker, calls } = github({ putStatus });
        assert.equal((await worker.fetch(request('POST', creation()), env)).status, 409);
        assert.equal(calls.filter((c) => c.method === 'PUT').length, 1);
    }
});

test('event endpoints retain JSON/origin/body-size/method protections and sanitized errors', async () => {
    const { worker, calls } = github();
    for (const [req, status] of [
        [request('POST', creation(), '/api/events', { 'Content-Type': 'text/plain' }), 415],
        [request('POST', creation(), '/api/events', { Origin: 'https://foreign.example' }), 403],
        [request('POST', 'x'.repeat(20001)), 413],
        [request('POST', creation(), '/api/events', { 'Content-Length': '20001' }), 413],
        [request('POST', '{broken'), 400],
        [request('DELETE', undefined, '/api/events/reviewed-jam'), 405],
        [request('GET', undefined, '/api/events/bad_id'), 404],
    ])
        assert.equal((await worker.fetch(req, env)).status, status);
    assert.equal(calls.length, 0);
    const failure = createWorker(async () => {
        throw new Error('secret transport details');
    });
    const response = await failure.fetch(request(), env);
    assert.equal(response.status, 502);
    assert(!(await response.text()).includes('secret transport details'));
});

test('mock Events and Projects share file SHA, support publish/archive/restore, and never call GitHub', async () => {
    const worker = createWorker(() => {
            throw new Error('GitHub forbidden');
        }),
        mock = { MOCK_MODE: 'true' };
    const listing = await (await worker.fetch(request(), mock)).json();
    assert.deepEqual(listing.events, []);
    const create = await worker.fetch(request('POST', { ...creation(), sha: listing.sha }), mock);
    assert.equal(create.status, 201);
    let saved = await create.json();
    assert.equal(saved.commitSha, null);
    const projectWrite = await worker.fetch(
        request(
            'PUT',
            {
                sha: listing.sha,
                title: { tr: 'TR', en: 'EN' },
                description: { tr: 'TR', en: 'EN' },
            },
            '/api/projects/stm32-beginner-resources',
        ),
        mock,
    );
    assert.equal(projectWrite.status, 409);
    for (const archived of [false, true, false]) {
        const result = await worker.fetch(
            request('PUT', { ...body(), sha: saved.sha, archived }, '/api/events/manual-event'),
            mock,
        );
        assert.equal(result.status, 200);
        saved = await result.json();
        assert.equal(saved.event.archived, archived);
    }
    const loaded = await (
        await worker.fetch(request('GET', undefined, '/api/events/manual-event'), mock)
    ).json();
    assert.equal(loaded.event.archived, false);
    assert.equal(
        (
            await worker.fetch(
                request('PUT', { ...body(), sha: listing.sha }, '/api/events/manual-event'),
                mock,
            )
        ).status,
        409,
    );
});

test('management sort is upcoming first, past newest first, archives last; input array stays untouched', () => {
    const events = [
        { id: 'past-old', date: '2025-01-01T00:00:00Z' },
        { id: 'archive', date: '2027-01-01T00:00:00Z', archived: true },
        { id: 'future-late', date: '2028-01-01T00:00:00Z' },
        { id: 'past-new', date: '2026-01-01T00:00:00Z' },
        { id: 'future-soon', date: '2027-01-01T00:00:00Z' },
    ];
    const before = structuredClone(events);
    assert.deepEqual(
        sortEvents(events, Date.parse('2026-11-09T00:00:00Z')).map((e) => e.id),
        ['future-soon', 'future-late', 'past-new', 'past-old', 'archive'],
    );
    assert.deepEqual(events, before);
});

test('production event edits preserve the original timezone/provenance in one write; no-op creates no commit', async () => {
    const first = github();
    const noop = await first.worker.fetch(request('PUT', body(), '/api/events/reviewed-jam'), env);
    assert.equal(noop.status, 200);
    assert.equal((await noop.json()).unchanged, true);
    assert.equal(first.calls.filter((c) => c.method === 'PUT').length, 0);
    const { worker, calls } = github();
    const date = '2028-03-01T18:30:00+05:30';
    const response = await worker.fetch(
        request('PUT', { ...body(), date }, '/api/events/reviewed-jam'),
        env,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).event.date, date);
    const writes = calls.filter((c) => c.method === 'PUT');
    assert.equal(writes.length, 1);
    const saved = decodeContent(JSON.parse(writes[0].body).content);
    assert.equal(saved, source.replace(JSON.stringify(event.date), JSON.stringify(date)));
    assert.deepEqual(JSON.parse(saved).events.items[0].external, external);
    const missing = await worker.fetch(request('GET', undefined, '/api/events/missing-event'), env);
    assert.equal(missing.status, 404);
});
