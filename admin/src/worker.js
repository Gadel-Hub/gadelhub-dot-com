import { ApiError, conflict } from './errors.js';
import {
    findProject,
    projectView,
    updateProject,
    createProject,
    validateEdit,
    validateCreate,
    validId,
} from './content.js';
import { repository } from './github.js';
import { mockContent } from './mock-project.js';

const MAX_BODY = 20000;
const mockSha = '0'.repeat(40);
const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const json = (body, status = 200, extra = {}) =>
    Response.json(body, { status, headers: { ...headers, ...extra } });

async function readEdit(request, create) {
    if (
        request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
        'application/json'
    ) {
        throw new ApiError(415, 'content_type', 'Send application/json.');
    }
    if (Number(request.headers.get('content-length')) > MAX_BODY)
        throw new ApiError(413, 'body_size', 'Request is too large.');
    const reader = request.body?.getReader();
    if (!reader) throw new ApiError(400, 'json', 'A JSON body is required.');
    let size = 0;
    const chunks = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BODY) {
            await reader.cancel();
            throw new ApiError(413, 'body_size', 'Request is too large.');
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }
    let body;
    try {
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
        throw new ApiError(400, 'json', 'Request must contain valid JSON.');
    }
    return create ? validateCreate(body) : validateEdit(body);
}

export function createWorker(fetcher = fetch) {
    let mockText = JSON.stringify(mockContent, null, 2) + '\n';
    let mockRevision = 0;
    let currentMockSha = mockSha;
    return {
        async fetch(request, env) {
            try {
                const url = new URL(request.url);
                const mock = env.MOCK_MODE === 'true';
                if (mock && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
                    throw new ApiError(
                        503,
                        'mock_local_only',
                        'Mock mode is restricted to local development.',
                    );
                }
                if (!url.pathname.startsWith('/api/')) {
                    if (!['GET', 'HEAD'].includes(request.method))
                        return json(
                            { error: { code: 'method', message: 'Method not allowed.' } },
                            405,
                            { Allow: 'GET, HEAD' },
                        );
                    const asset = await env.ASSETS.fetch(request);
                    const response = new Response(asset.body, asset);
                    for (const [key, value] of Object.entries(headers))
                        response.headers.set(key, value);
                    return response;
                }
                const match = /^\/api\/projects(?:\/([a-z0-9-]+))?$/.exec(url.pathname);
                if (!match || (match[1] && !validId(match[1])))
                    throw new ApiError(404, 'route', 'API route not found.');
                const id = match[1];
                const allowed = id ? ['GET', 'PUT'] : ['GET', 'POST'];
                if (!allowed.includes(request.method))
                    return json(
                        { error: { code: 'method', message: 'Method not allowed.' } },
                        405,
                        { Allow: allowed.join(', ') },
                    );
                // Access supplies authentication; same-origin JSON writes also block cross-site submissions.
                if (['PUT', 'POST'].includes(request.method)) {
                    if (
                        request.headers.get('origin') !== url.origin ||
                        request.headers.get('sec-fetch-site') === 'cross-site'
                    ) {
                        throw new ApiError(
                            403,
                            'origin',
                            'Publishing requires a same-origin request.',
                        );
                    }
                }
                const creating = request.method === 'POST';
                const edit = ['PUT', 'POST'].includes(request.method)
                    ? await readEdit(request, creating)
                    : null;
                if (mock) {
                    const data = JSON.parse(mockText);
                    if (edit && edit.sha !== currentMockSha) throw conflict();
                    if (edit) {
                        const updated = creating
                            ? createProject(mockText, edit)
                            : updateProject(mockText, id, edit);
                        const unchanged = mockText === updated.text;
                        mockText = updated.text;
                        if (!unchanged)
                            currentMockSha = (++mockRevision).toString(16).padStart(40, '0');
                        return json(
                            {
                                mode: 'mock',
                                project: updated.project,
                                sha: currentMockSha,
                                commitSha: null,
                                ...(unchanged ? { unchanged: true } : {}),
                            },
                            creating ? 201 : 200,
                        );
                    }
                    return json({
                        mode: 'mock',
                        sha: currentMockSha,
                        ...(id
                            ? { project: projectView(findProject(data, id)) }
                            : { projects: data.projects.map(projectView) }),
                    });
                }
                const repo = await repository(env, fetcher);
                const current = await repo.load();
                if (!edit)
                    return json({
                        mode: 'github',
                        sha: current.sha,
                        ...(id
                            ? { project: projectView(findProject(current.data, id)) }
                            : { projects: current.data.projects.map(projectView) }),
                    });
                if (edit.sha !== current.sha) throw conflict();
                const updated = creating
                    ? createProject(current.text, edit)
                    : updateProject(current.text, id, edit);
                if (updated.text === current.text)
                    return json({
                        mode: 'github',
                        project: updated.project,
                        sha: current.sha,
                        commitSha: null,
                        unchanged: true,
                    });
                const result = await repo.save(updated.text, current.sha, creating ? edit.id : id);
                return json(
                    { mode: 'github', project: updated.project, ...result },
                    creating ? 201 : 200,
                );
            } catch (error) {
                if (error instanceof ApiError)
                    return json(
                        { error: { code: error.code, message: error.message } },
                        error.status,
                    );
                return json(
                    {
                        error: {
                            code: 'internal',
                            message:
                                'The request could not be completed. Reload before trying again.',
                        },
                    },
                    500,
                );
            }
        },
    };
}

export default createWorker();
