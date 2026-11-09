# GADEL project admin

**Production must be protected by Cloudflare Access across the entire admin hostname, including static assets and every `/api/*` route. Never expose this Worker without that protection.** There is no application login, session store, OAuth flow, or second authentication system. Do not treat an arbitrary Access identity header as proof of authentication. This version relies on Access enforcing its policy before requests reach the Worker; it does not validate Access JWTs itself.

Planned hostname: `admin.gadelhub.com`. No domain, Access application, GitHub App, or deployment is created by the checked-in configuration. `workers.dev` and version preview URLs are disabled; keep them disabled and protect any additional entry point before enabling it.

## Architecture and scope

Vanilla HTML/CSS/JavaScript → Worker API → dedicated GitHub App → `content/home.json` commit → separate public deployment build. The admin has its own Worker/static-assets deployment. It is never included in the public Python `dist/` build.

Projects management lists all structured project records, including unverified and archived records. Select a record, edit both languages and domain/verification/visibility, review the component previews, then explicitly publish. New projects require a unique immutable kebab-case ID, a canonical domain, both titles/descriptions and a verification flag. The UI starts new drafts archived and unverified. Symbols are assigned from the domain at creation and remain read-only; existing extra metadata is preserved. There is no hard-delete or ID rename operation.

### Visibility

`verified` retains its existing review meaning. Verified, non-archived projects appear on the Projects page. The homepage already includes non-archived area/directory records even when unverified; the editor and previews explain this. The only schema addition is optional `archived: boolean` (default false). Archiving hides a record from **all** public project listings while retaining identity, translations, domain, verification and history. Unchecking archive and publishing restores visibility under the existing verification rules. No content migration is required.

### API

- `GET /api/projects` — all projects and current content-file SHA.
- `GET /api/projects/:id` — one project, including hidden/unverified records, and file SHA.
- `POST /api/projects` — `{ "sha": "<loaded-file-sha>", "id": "stable-slug", "domain": "game-development", "verified": false, "archived": true, "title": { "tr": "…", "en": "…" }, "description": { "tr": "…", "en": "…" } }`.
- `PUT /api/projects/:id` — same editable fields and SHA, without `id`. Legacy title/description-only edits remain supported. Domain, verified and archived are optional on PUT; omitted values are preserved. `archived` is optional on POST and defaults false.

Canonical domains are `game-development` and `electronics-embedded`. IDs must be unique across the complete content document and match `[a-z0-9]+(?:-[a-z0-9]+)*` (maximum 100 characters). ID and symbol cannot be edited. Titles are required up to 160 characters per language; descriptions up to 2000. Extra fields/languages and non-boolean flags are rejected. Writes require same-origin JSON and are capped at 20,000 bytes, including streamed requests. Repository/path/configuration never come from the browser.

Every publish refetches the file and checks the expected SHA before GitHub's atomic Contents update. Stale edits return `409`; drafts remain and publishing is blocked until explicit reload. No automatic write retry occurs. An uncertain network result also requires reload. No-op edits create no commit. Creation appends one record; updates replace only changed source values and preserve unrelated bytes, record order and metadata. Each successful publish creates one single-file `content/home.json` commit. A successful source commit does not prove the public deployment finished. Python remains the authoritative full-site validator during deployment.

## Local development (no credentials)

Use Node 22 or newer:

```sh
cd admin
npm ci
npm test
npm run dev
```

Open the local URL printed by Wrangler (normally `http://127.0.0.1:8787`). `npm run dev` explicitly passes `MOCK_MODE=true`, binds loopback, preserves the local request origin instead of inferring the configured production route, and uses Wrangler's local runtime. The UI displays a prominent mock banner and labels the action **Simulate publish**. The mock starts from a build-time snapshot of `content/home.json`. Simulation creates no commit and changes only the local Worker’s memory. Simulated records persist across page reloads and tabs until that Worker restarts; they never modify source content. Local SHA revisions make competing-tab conflicts realistic. The mock-only **Simulate stale SHA** control intentionally causes the next publish to conflict so the retained-draft/reload flow can be tested. There is no automatic mock fallback. Mock mode refuses non-loopback request hostnames; never configure `MOCK_MODE` in production.

Tests use Node's built-in test runner and mock GitHub, with an ephemeral test RSA key generated in memory. They require neither installed Wrangler nor account credentials (`node --test` also works directly from `admin/`). The UI event handlers are tested with a small DOM adapter; this does not replace a browser layout review.

```sh
npm run format    # Format admin source and configuration
npm run format:check
npm run check     # Wrangler bundle/config dry-run; does not deploy
npm run dev:github  # optional local runtime using explicit .dev.vars credentials
```

`dev:github` can make real commits to the configured repository/branch. Use it only deliberately against an appropriate test branch, selected with Wrangler `--var` or the non-secret config. With `secrets.required`, Wrangler loads only the listed secret names from local `.dev.vars`/`.env`; set other variables separately. Local `.dev.vars`, `.env*`, dependencies, and `.wrangler/` output are ignored. Never commit credentials. In restricted environments, Wrangler's configuration/log directory may need a writable location via `XDG_CONFIG_HOME` and `WRANGLER_LOG_PATH`.

See [the deployment guide](../docs/DEPLOYMENT.md) for DNS, Workers Builds, Access, and the full production sequence.

## Production configuration (future setup)

Create a dedicated GitHub App and install it **only on this repository**. Grant repository **Contents: read and write** (plus GitHub's mandatory Metadata: read); no other permissions or webhook subscriptions are needed. Branch rules must permit the intended App commit without bypassing required checks accidentally. Installation tokens are additionally narrowed to the configured repository and Contents write. No personal access token is supported.

Non-secret Wrangler vars:

- `GITHUB_OWNER` — `Gadel-Hub`
- `GITHUB_REPO` — `gadelhub-dot-com`
- `GITHUB_BRANCH` — `main` (also the server default)

The config declares the three required secret names. Missing secrets produce a local warning in mock mode and block a production deployment. After setting up Access, configure secrets during the later authorized setup (each `secret put` deploys a Worker version):

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

Do not run it as part of local development. The checked-in Custom Domain route becomes active on a real deployment; set up and verify Access before exposing it. Protect the whole hostname with Access before making it reachable. GitHub publication errors are sanitized and classified (authentication, permission/not-found, rate limit, malformed content/response, network, and conflict). A source commit can succeed even if the subsequent deployment fails; confirm deployment separately.

## References

- [Cloudflare Worker static assets](https://developers.cloudflare.com/workers/static-assets/binding/)
- [GitHub App JWT authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)
- [GitHub installation tokens](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)
- [GitHub Contents updates](https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents)
