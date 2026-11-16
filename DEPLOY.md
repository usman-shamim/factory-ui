# DEPLOY — the two targets

One build, two destinations. The bundle carries no secrets in either.

## Build

```bash
VITE_BRIDGE_URL=https://factory.usman-hermes.duckdns.org npm run build:app
# → dist-app/index.html + dist-app/assets/{index-*.js,index-*.css}
```

`ui-app/vite.config.ts` **throws** if `VITE_BRIDGE_URL` is missing or not a bare
`http(s)://` URL. An absolute same-origin URL is used on purpose: it satisfies
the guard and still behaves as same-origin when Caddy serves the site.

## Target 1 — Caddy on the VM (live today)

No deploy step: Caddy serves the working tree directly.

```
factory.usman-hermes.duckdns.org {
    handle /webhook/github { reverse_proxy 127.0.0.1:8787 }   # HMAC, public
    handle /oauth2/*       { reverse_proxy 127.0.0.1:4180 }   # GitHub SSO
    handle {
        forward_auth 127.0.0.1:4180 { ... }
        handle /api/* { reverse_proxy 127.0.0.1:8787 { header_up X-Farm-User {http.request.header.X-Auth-Request-User} } }
        handle /ws    { reverse_proxy 127.0.0.1:8787 { header_up X-Farm-User {http.request.header.X-Auth-Request-User} } }
        handle { root * /home/ubuntu/factory-ui-repo/dist-app
                 try_files {path} /index.html
                 file_server }
    }
}
```

After a build the new asset hash is served immediately — no reload, no restart.
**Requires the build to run on the VM** (`git pull && npm run build:app`).

## Target 2 — Cloudflare Pages (not created yet)

`factory-ui.pages.dev` does not resolve, so there is no project. Two ways to
create it, and the choice decides whether anything else is blocked.

### Option A — Pages Git integration (recommended)

Connect the repo in the Cloudflare dashboard. **No workflow file, so the missing
`workflow` OAuth scope is irrelevant.**

| Setting | Value |
|---|---|
| Repository | `usman-shamim/factory-ui` |
| Production branch | `main` |
| Framework preset | None |
| Build command | `npm run build:app` |
| Output directory | `dist-app` |
| Node version | `22` (matches `.node-version`) |
| Env var (all envs) | `VITE_BRIDGE_URL = https://factory.usman-hermes.duckdns.org` |

Result: `git push factory main` → Pages builds → `https://factory-ui.pages.dev`.

### Option B — CI deploy with wrangler

Needs a `.github/workflows/*.yml`, which needs the `workflow` OAuth scope:

```bash
gh auth refresh -s workflow
```

Then a scoped token beats interactive login on a headless host:

```bash
export CLOUDFLARE_API_TOKEN=...   # Pages:Edit
export CLOUDFLARE_ACCOUNT_ID=...
npx wrangler pages deploy dist-app --project-name factory-ui
```

`npx wrangler login` is **not** usable here: it binds a browser callback to
`localhost:8976` on a headless VM.

## Cross-origin consequences (Pages only)

With the UI on `*.pages.dev` and the API on the DuckDNS host:

- The bridge already allows `https://factory-ui.pages.dev` and
  `https://*.factory-ui.pages.dev` in `CORS_ORIGINS`, and now sends
  `X-Farm-Token` in `Access-Control-Allow-Headers`.
- The `oauth2-proxy` session cookie cannot reach the bridge from another origin,
  so `/api/session` must be reached with `credentials: "include"` and CORS
  credentials enabled — already the case.
- Cloudflare Access cannot gate either host without a domain you own.

## Verify a deploy

```bash
# 1. the build produced the expected hash
grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' dist-app/index.html

# 2. the behavior is actually in the shipped bundle
grep -c 'localStorage\|max-width: 760px' dist-app/assets/*.js

# 3. the edge answers (302 to SSO is correct when unauthenticated)
curl -s -o /dev/null -w '%{http_code}\n' https://factory.usman-hermes.duckdns.org/
```

A green build is not proof the code shipped; step 2 is.
