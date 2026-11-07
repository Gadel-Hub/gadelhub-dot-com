import { ApiError, conflict } from './errors.js';
import { findProject, projectView, updateProject, validateEdit, validId } from './content.js';
import { repository } from './github.js';
import { mockProject } from './mock-project.js';

const MAX_BODY = 20000;
const mockSha = '0'.repeat(40);
const headers = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const json = (body, status = 200, extra = {}) => Response.json(body, { status, headers: { ...headers, ...extra } });

async function readEdit(request) {
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new ApiError(415, 'content_type', 'Send application/json.');
    }
    if (Number(request.headers.get('content-length')) > MAX_BODY) throw new ApiError(413, 'body_size', 'Request is too large.');
    const reader = request.body?.getReader();
    if (!reader) throw new ApiError(400, 'json', 'A JSON body is required.');
    let size = 0;
    const chunks = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > MAX_BODY) { await reader.cancel(); throw new ApiError(413, 'body_size', 'Request is too large.'); }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    let body;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new ApiError(400, 'json', 'Request must contain valid JSON.'); }
    return validateEdit(body);
}

export function createWorker(fetcher = fetch) {
    return { async fetch(request, env) {
        try {
            const url = new URL(request.url);
            const mock = env.MOCK_MODE === 'true';
            if (mock && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
                throw new ApiError(503, 'mock_local_only', 'Mock mode is restricted to local development.');
            }
            if (!url.pathname.startsWith('/api/')) {
                if (!['GET', 'HEAD'].includes(request.method)) return json({ error: { code: 'method', message: 'Method not allowed.' } }, 405, { Allow: 'GET, HEAD' });
                const asset = await env.ASSETS.fetch(request);
                const response = new Response(asset.body, asset);
                for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
                return response;
            }
            const match = /^\/api\/projects(?:\/([a-z0-9-]+))?$/.exec(url.pathname);
            if (!match || (match[1] && !validId(match[1]))) throw new ApiError(404, 'route', 'API route not found.');
            const id = match[1];
            const allowed = id ? ['GET', 'PUT'] : ['GET'];
            if (!allowed.includes(request.method)) return json({ error: { code: 'method', message: 'Method not allowed.' } }, 405, { Allow: allowed.join(', ') });
            // Access supplies authentication; same-origin JSON writes also block cross-site submissions.
            if (request.method === 'PUT') {
                if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') {
                    throw new ApiError(403, 'origin', 'Publishing requires a same-origin request.');
                }
            }
            const edit = request.method === 'PUT' ? await readEdit(request) : null;
            if (mock) {
                if (id && id !== mockProject.id) throw new ApiError(404, 'project_not_found', 'Verified project not found.');
                if (edit && edit.sha !== mockSha) throw conflict();
                const project = projectView(mockProject);
                if (edit) { project.title = edit.title; project.description = edit.description; }
                return json(id ? { mode: 'mock', project, sha: mockSha, ...(edit ? { commitSha: null } : {}) }
                    : { mode: 'mock', projects: [project], sha: mockSha });
            }
            const repo = await repository(env, fetcher);
            const current = await repo.load();
            if (!id) return json({ mode: 'github', projects: current.data.projects.filter((p) => p.verified).map(projectView), sha: current.sha });
            const project = projectView(findProject(current.data, id));
            if (!edit) return json({ mode: 'github', project, sha: current.sha });
            if (edit.sha !== current.sha) throw conflict();
            const updated = updateProject(current.text, id, edit);
            if (updated.text === current.text) return json({ mode: 'github', project, sha: current.sha, commitSha: null, unchanged: true });
            const result = await repo.save(updated.text, current.sha, id);
            return json({ mode: 'github', project: updated.project, ...result });
        } catch (error) {
            if (error instanceof ApiError) return json({ error: { code: error.code, message: error.message } }, error.status);
            return json({ error: { code: 'internal', message: 'The request could not be completed. Reload before trying again.' } }, 500);
        }
    } };
}

export default createWorker();
