import { ApiError, conflict } from './errors.js';
import { parseContent, validSha } from './content.js';

export function encodeContent(text) {
    return btoa(
        Array.from(new TextEncoder().encode(text), (byte) => String.fromCharCode(byte)).join(''),
    );
}

export function decodeContent(value) {
    try {
        if (typeof value !== 'string' || value.length > 1_500_000) throw new Error();
        return new TextDecoder('utf-8', { fatal: true }).decode(
            Uint8Array.from(atob(value.replace(/\s/g, '')), (char) => char.charCodeAt(0)),
        );
    } catch {
        throw new ApiError(502, 'invalid_github_response', 'GitHub returned invalid file content.');
    }
}

const base64url = (bytes) =>
    btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
const jwtPart = (value) => base64url(new TextEncoder().encode(JSON.stringify(value)));

// Web Crypto imports PKCS#8. Wrap GitHub's PKCS#1 RSA key without changing its key material.
function der(tag, bytes) {
    const length = bytes.length;
    const size =
        length < 128 ? [length] : length < 256 ? [0x81, length] : [0x82, length >> 8, length & 255];
    return new Uint8Array([tag, ...size, ...bytes]);
}

export async function appJwt(env, now = Math.floor(Date.now() / 1000)) {
    try {
        const pem = env.GITHUB_PRIVATE_KEY;
        const pkcs1 = pem.includes('BEGIN RSA PRIVATE KEY');
        const raw = Uint8Array.from(
            atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '')),
            (char) => char.charCodeAt(0),
        );
        const algorithm = [
            0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05,
            0x00,
        ];
        const pkcs8 = pkcs1
            ? der(0x30, new Uint8Array([0x02, 0x01, 0x00, ...algorithm, ...der(0x04, raw)]))
            : raw;
        const key = await crypto.subtle.importKey(
            'pkcs8',
            pkcs8,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['sign'],
        );
        const unsigned = `${jwtPart({ alg: 'RS256', typ: 'JWT' })}.${jwtPart({ iat: now - 60, exp: now + 540, iss: env.GITHUB_APP_ID })}`;
        const signature = await crypto.subtle.sign(
            'RSASSA-PKCS1-v1_5',
            key,
            new TextEncoder().encode(unsigned),
        );
        return `${unsigned}.${base64url(new Uint8Array(signature))}`;
    } catch {
        throw new ApiError(
            503,
            'github_configuration',
            'GitHub App credentials are missing or invalid.',
        );
    }
}

async function github(fetcher, path, token, method = 'GET', body) {
    let response;
    try {
        response = await fetcher(`https://api.github.com${path}`, {
            method,
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
            headers: {
                Accept: 'application/vnd.github+json',
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                'User-Agent': 'GADEL-Project-Admin',
                'X-GitHub-Api-Version': '2026-03-10',
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch {
        throw new ApiError(
            502,
            method === 'PUT' ? 'publish_unknown' : 'github_network',
            method === 'PUT'
                ? 'Publish result could not be confirmed. Reload before trying again.'
                : 'GitHub could not be reached. Try loading again.',
        );
    }
    if (!response.ok) {
        if (method === 'PUT' && [409, 422].includes(response.status)) throw conflict();
        if (response.status === 429 || response.headers.get('x-ratelimit-remaining') === '0') {
            throw new ApiError(
                503,
                'github_rate_limit',
                'GitHub rate limit reached. Please try later.',
            );
        }
        const failures = {
            401: ['github_auth', 'GitHub App authentication failed. Contact an administrator.'],
            403: [
                'github_permission',
                'GitHub denied access. Check App permissions and branch rules.',
            ],
            404: [
                'github_not_found',
                'Configured GitHub repository, installation or content file was not found.',
            ],
        };
        const [code, message] = failures[response.status] || [
            'github_failure',
            method === 'PUT'
                ? 'GitHub could not confirm publishing. Reload before trying again.'
                : 'GitHub is unavailable. Please try later.',
        ];
        throw new ApiError(502, code, message);
    }
    try {
        return await response.json();
    } catch {
        throw new ApiError(
            502,
            'invalid_github_response',
            'GitHub returned an unreadable response. Reload before continuing.',
        );
    }
}

export async function repository(env, fetcher = fetch) {
    if (
        !/^\d+$/.test(env.GITHUB_APP_ID || '') ||
        !/^\d+$/.test(env.GITHUB_INSTALLATION_ID || '') ||
        !/^[a-zA-Z0-9-]+$/.test(env.GITHUB_OWNER || '') ||
        !/^[a-zA-Z0-9_.-]+$/.test(env.GITHUB_REPO || '') ||
        !env.GITHUB_PRIVATE_KEY
    ) {
        throw new ApiError(
            503,
            'github_configuration',
            'GitHub repository/App configuration is incomplete.',
        );
    }
    const jwt = await appJwt(env);
    const installation = await github(
        fetcher,
        `/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`,
        jwt,
        'POST',
        {
            repositories: [env.GITHUB_REPO],
            permissions: { contents: 'write' },
        },
    );
    if (
        !installation ||
        typeof installation.token !== 'string' ||
        !installation.token ||
        !(Date.parse(installation.expires_at) > Date.now())
    ) {
        throw new ApiError(
            502,
            'invalid_github_response',
            'GitHub returned an invalid installation token.',
        );
    }
    const path = `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/content/home.json`;
    const branch = env.GITHUB_BRANCH || 'main';
    return {
        async load() {
            const file = await github(
                fetcher,
                `${path}?ref=${encodeURIComponent(branch)}`,
                installation.token,
            );
            if (
                !file ||
                file.type !== 'file' ||
                file.encoding !== 'base64' ||
                !validSha(file.sha)
            ) {
                throw new ApiError(
                    502,
                    'invalid_github_response',
                    'GitHub did not return the expected content file.',
                );
            }
            const text = decodeContent(file.content);
            return { sha: file.sha, text, data: parseContent(text) };
        },
        async save(text, sha, id) {
            const result = await github(fetcher, path, installation.token, 'PUT', {
                message: `content: update ${id}`,
                content: encodeContent(text),
                sha,
                branch,
            });
            if (!result || !validSha(result.commit?.sha) || !validSha(result.content?.sha)) {
                throw new ApiError(
                    502,
                    'invalid_github_response',
                    'Publish response was incomplete. Reload to check repository state.',
                );
            }
            return { sha: result.content.sha, commitSha: result.commit.sha };
        },
    };
}
