# Cloudflare production deployment

This is a manual setup guide. The repository prepares configuration only; it does not create accounts, DNS records, policies, Workers, GitHub Apps, or deploy them. The public Worker serves the static `dist/` build at `gadelhub.com`. A separate Worker serves the GitHub-backed editor at `admin.gadelhub.com`.

## 1. DNS and domain registration

1. Add `gadelhub.com` as a zone in Cloudflare. Before changing nameservers, inventory and copy the existing Wix DNS records into Cloudflare, especially MX, TXT, and mail verification/authentication records. Check other records used by existing services too.
2. At Wix, change the domain's nameservers to the nameservers Cloudflare assigns to this zone. The domain can remain registered at Wix; transferring the registrar is not required and can be considered independently later.
3. Wait for Cloudflare to report the zone active and verify its assigned nameservers are authoritative before attaching production domains. Confirm mail-related records and existing services still work.
4. Review any existing DNS records for the two intended hostnames before attaching them: a Worker Custom Domain creates a DNS record and may conflict with existing records. Plan the public cutover deliberately; do not remove mail or unrelated service records.

## 2. Protect the admin before exposure

In Cloudflare Zero Trust, create an Access application for the **entire** `admin.gadelhub.com` hostname, including static assets and `/api/*`, with deny-by-default behavior and an allow policy for explicitly authorized maintainer identities only. Configure and verify the policy **before** the admin route can receive traffic or any Builds import can deploy it. The application does not implement its own authentication or validate Access JWTs.

Keep `workers_dev` and `preview_urls` disabled as configured, and disable non-production preview builds in Workers Builds. Hostname-based Access covers only its configured hostname; do not add an alternate Worker route, preview, or hostname unless it is also protected. Worker-level Access can additionally protect the entire Worker. Test from an unauthenticated browser and confirm Access denies or challenges access; also confirm an authorized maintainer can reach the admin after deployment. Do not use the admin until both checks pass.

## 3. Dedicated GitHub App

1. Create a dedicated GitHub App; disable the webhook if unused. Grant repository **Contents: Read and write**, plus GitHub's required read-only Metadata permission. Do not grant unrelated write permissions.
2. Install it only on the GADEL website repository. Obtain its numeric App ID and installation ID, then generate its private key. Do not use a personal access token. The Worker signs an App JWT and exchanges it for a repository-scoped installation access token.
3. Store these three values as **runtime Worker secrets**, not Git, build variables, `vars`, logs, or browser code:

   - `GITHUB_APP_ID`
   - `GITHUB_INSTALLATION_ID`
   - `GITHUB_PRIVATE_KEY`

   Set them on the admin Worker through its Cloudflare dashboard **Variables & Secrets** settings during authorized setup, or use `wrangler secret put` from `admin/` after the Access boundary is in place. `wrangler secret put` creates and deploys a Worker version; it is not an offline preparation command. Wrangler's `secrets.required` declares the names and validates them on production deployment. A dry run does not prove secrets exist in the account. Local mock mode needs no values; Wrangler may warn about missing required secrets locally.

4. Review `main` branch protection/rules so the App can make the intended content commit without inadvertently bypassing required controls. A rejected GitHub write does not publish content.

## 4. Public Worker and Workers Builds

Create/import a Worker named `gadel-public` and connect this GitHub repository to it in Workers Builds. Confirm the dashboard Worker name matches `wrangler.public.jsonc`. Configure:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | repository root (`/`) |
| Build command | `python3 scripts/build.py` |
| Deploy command | `npx wrangler deploy --config wrangler.public.jsonc` |
| Custom Domain | `gadelhub.com` |

Workers Builds must install the locked root npm dependencies (including pinned Wrangler) and provide Node 22+ and Python 3.9+. Keep automatic dependency installation enabled, or explicitly run `npm ci` before the build if it is disabled. The deploy command uses the existing build's `dist/`; it does not execute the Python build itself. For manual local verification without deploying:

```sh
npm ci
npm run build
npm run check
```

`wrangler.public.jsonc` configures `./dist`, automatic directory trailing slashes, and 404 handling; it does not use an SPA fallback or runtime rendering. Both `workers.dev` and version URLs are disabled. The checked-in route binds the apex Custom Domain **when a real deployment occurs**. After authorized cutover, check the build/deployment status and verify `/`, `/tr/`, `/en/`, `/tr/projects/`, `/en/projects/`, and a nonexistent path on the production domain. Verify the root redirect and linked assets as well.

## 5. Admin Worker and Workers Builds

With the Access application already in place, create/import a separate Worker named `gadel-project-admin`, connect the same repository, and prevent an automatic first deployment until Access, runtime secrets, and these settings are ready. Confirm:

| Setting | Value |
| --- | --- |
| Production branch | `main` |
| Root directory | `admin/` |
| Build command | `npm ci && npm run format:check && npm test && npm run check` |
| Deploy command | `npx wrangler deploy` |
| Custom Domain | `admin.gadelhub.com` |

For this explicit install command, set the **build** variable `SKIP_DEPENDENCY_INSTALL` to `true` to avoid an automatic install before `npm ci`. This is a build-only setting. Set runtime non-secret variables `GITHUB_OWNER`, `GITHUB_REPO`, and `GITHUB_BRANCH` to match the repository and `main` (the checked-in Wrangler config already provides them); set the three runtime secrets listed above on this Worker. Build variables are not runtime Worker secrets. Do not set `MOCK_MODE` in production.

`admin/wrangler.jsonc` routes the Custom Domain to the Worker and retains its assets binding and API behavior. Its `workers.dev` and version URLs remain disabled. The admin `npm run check` is a local Wrangler dry run, not a deployment. After the first authorized deployment, repeat the Access denial and authorized-access tests before normal use. Do not expose or use the editor without a verified Access boundary.

## 6. Build watch paths

Set these **include paths in the Workers Builds dashboard**, relative to the repository root, with no exclusions that override them. Cloudflare's watch syntax uses `*`, including for nested paths; review the dashboard's current matching behavior and test it after setup.

- Public: `content/*`, `src/*`, `assets/*`, `styles/*`, `scripts/build.py`, `wrangler.public.jsonc`, `package.json`, `package-lock.json`.
- Admin: `admin/*`.

An admin-generated `content/home.json` commit must match the public watch paths and start a public deployment; it should not match the admin paths. Cloudflare can bypass watch filters for empty or unusually large pushes, so they are an optimization rather than a security boundary. Admin tests read the repository's content fixture; changing content alone will not trigger an admin build under these filters.

## 7. First end-to-end test

1. Confirm Access blocks an unauthenticated visitor and admits an authorized maintainer.
2. Open the admin and load the verified project. Make a harmless, reversible text edit and explicitly Publish.
3. Confirm the resulting GitHub commit modifies only the intended source content.
4. Confirm a public Workers Build starts for that commit, succeeds, and deploys the change.
5. Confirm the public site displays the change in the appropriate language. Revert through the admin or Git if necessary and verify the resulting public deployment.

## Production checklist

- [ ] Cloudflare zone active and authoritative; existing DNS records, especially mail records, preserved.
- [ ] Access active for the entire admin hostname; unauthenticated denial tested.
- [ ] GitHub App installed only on the intended repository with minimum permissions.
- [ ] No credentials committed; all required admin Worker secrets present.
- [ ] `workers.dev` and version/preview exposure disabled or intentionally protected.
- [ ] Admin mock mode absent in production.
- [ ] Public build succeeds and admin tests pass.
- [ ] First publish uses harmless, reversible content; public deployment is verified.

Cloudflare references: [Workers static HTML routing](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/), [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [required secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/), [build watch paths](https://developers.cloudflare.com/workers/ci-cd/builds/build-watch-paths/), and [Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).
