# GADEL project admin

**Production must be protected by Cloudflare Access across the entire admin hostname, including static assets and every `/api/*` route. Never expose this Worker without that protection.** There is no application login, session store, OAuth flow, or second authentication system. Do not treat an arbitrary Access identity header as proof of authentication. This version relies on Access enforcing its policy before requests reach the Worker; it does not validate Access JWTs itself.

Planned hostname: `admin.gadelhub.com`. No domain, Access application, GitHub App, or deployment is created by this repository change. `workers.dev` and version preview URLs are disabled; keep them disabled and protect any additional entry point before enabling it.

## Architecture and scope

Vanilla HTML/CSS/JavaScript → Worker API → dedicated GitHub App → `content/home.json` commit → separate public deployment build. The admin has its own Worker/static-assets deployment. It is never included in the public Python `dist/` build.

V1 lists verified projects and edits only TR/EN title and description. ID, domain, verified status, and other content cannot be changed. The preview is local and uses text nodes, not injected HTML. No autosave. Publish creates one single-file GitHub Contents API update with message `content: update <project-id>`. A successful commit does not prove the public deployment has finished.

Routes:

- `GET /api/projects` — verified projects and current content-file SHA.
- `GET /api/projects/:id` — one verified project and its content-file SHA.
- `PUT /api/projects/:id` — JSON `{ "sha": "<loaded-file-sha>", "title": { "tr": "…", "en": "…" }, "description": { "tr": "…", "en": "…" } }`.

Titles are required strings up to 160 characters per language; descriptions up to 2000. Extra fields/languages are rejected. JSON requests are capped at 20,000 bytes. Browser writes must be same-origin; no CORS API is provided. The file path and repository configuration never come from the browser.

Publish refetches the file and compares SHAs, then submits GitHub's atomic SHA precondition. Stale edits return `409`; drafts are retained and publishing is blocked until an explicit reload. Writes are never silently retried. If a network failure leaves the commit result uncertain, reload before trying again. No-op edits create no commit. Source string replacements preserve record order, whitespace and unrelated values, with a trailing newline. Python remains the authoritative full-site validator during deployment.

## Local development (no credentials)

Use Node 22 or newer:

```sh
cd admin
npm ci
npm test
npm run dev
```

Open the local URL printed by Wrangler (normally `http://127.0.0.1:8787`). `npm run dev` explicitly passes `MOCK_MODE=true`, binds loopback, and uses Wrangler's local runtime. The UI displays a prominent mock banner and labels the action **Simulate publish**. The fixture is copied from the existing verified STM32 project; simulation creates no commit, stores nothing, and resets on reload. There is no automatic mock fallback. Mock mode refuses non-loopback request hostnames; never configure `MOCK_MODE` in production.

Tests use Node's built-in test runner and mock GitHub, with an ephemeral test RSA key generated in memory. They require neither installed Wrangler nor account credentials (`node --test` also works directly from `admin/`). The UI event handlers are tested with a small DOM adapter; this does not replace a browser layout review.

```sh
npm run check     # Wrangler bundle/config dry-run; does not deploy
npm run dev:github  # optional local runtime using explicit .dev.vars credentials
```

`dev:github` can make real commits to the configured repository/branch. Use it only deliberately against an appropriate test branch. Local `.dev.vars`, `.env*`, dependencies, and `.wrangler/` output are ignored. Never commit credentials. In restricted environments, Wrangler's configuration/log directory may need a writable location via `XDG_CONFIG_HOME` and `WRANGLER_LOG_PATH`.

## Production configuration (future setup)

Create a dedicated GitHub App and install it **only on this repository**. Grant repository **Contents: read and write** (plus GitHub's mandatory Metadata: read); no other permissions or webhook subscriptions are needed. Branch rules must permit the intended App commit without bypassing required checks accidentally. Installation tokens are additionally narrowed to the configured repository and Contents write. No personal access token is supported.

Non-secret Wrangler vars:

- `GITHUB_OWNER` — `Gadel-Hub`
- `GITHUB_REPO` — `gadelhub-dot-com`
- `GITHUB_BRANCH` — `main` (also the server default)

Set App configuration using secrets, from `admin/`, during the later authorized setup:

```sh
npx wrangler secret put GITHUB_APP_ID
npx wrangler secret put GITHUB_INSTALLATION_ID
npx wrangler secret put GITHUB_PRIVATE_KEY
```

Use the numeric App ID and installation ID. Paste the complete multiline PEM private key when prompted. Both GitHub's RSA PKCS#1 and PKCS#8 PEM formats are supported. Web Crypto signs a short-lived RS256 App JWT; the Worker exchanges it for an installation token server-side. Credentials are neither logged nor returned to the browser. There is no token cache in V1.

After Access protection, hostname configuration, App permissions and the independent public build/deployment integration have been reviewed, the future deployment command is:

```sh
npm run deploy
```

Do not run it as part of local development. The checked-in config has no custom-domain route; add the reviewed hostname configuration only during live setup. Protect the whole hostname with Access before making it reachable. GitHub publication errors are sanitized and classified (authentication, permission/not-found, rate limit, malformed content/response, network, and conflict). A source commit can succeed even if the subsequent deployment fails; confirm deployment separately.

## References

- [Cloudflare Worker static assets](https://developers.cloudflare.com/workers/static-assets/binding/)
- [GitHub App JWT authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)
- [GitHub installation tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [GitHub Contents updates](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents)
