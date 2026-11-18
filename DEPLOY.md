# DEPLOY — one deployment target (Caddy, same origin) and one local run path

The app is served from the factory host and talks to the bridge on the same
origin. There is no second deployment target and no CORS in the request path.
The bridge itself is versioned in this repository under [`bridge/`](bridge/), so
the console can also run on this machine against live local data.

## Local run path (this machine)

Two commands, one origin. `npm run dev` serves the app and proxies `/api` and
`/ws` to the bridge, so the app keeps its existing relative fetch paths and no
CORS enters the request path. There is no edge, no SSO, no JWT and no Caddy in
this mode.

```bash
npm install      # once
npm run bridge   # terminal 1: the bridge on 127.0.0.1:8787
npm run dev      # terminal 2: the app on http://localhost:5173
```

| Piece | Address | Command |
| :--- | :--- | :--- |
| Bridge (read models) | `http://127.0.0.1:8787` | `npm run bridge` |
| App dev server | `http://localhost:5173` | `npm run dev` |
| Shape tests | none | `npm test` |

- `FM_HOME` selects the Firstmate home the bridge reads and defaults to
  `/mnt/main/Projects/VM-agent/firstmate`.
- `FM_BRIDGE_PORT` overrides the bridge port. The dev proxy targets `8787`
  (`ui-app/vite.config.ts`), so changing the port means changing that too.
- Do **not** set `VITE_BRIDGE_URL` for `npm run dev`. An empty value is what makes
  the app call `/api` and `/ws` relatively, which the proxy serves. `npm run
  build:app` still requires the variable and still throws without it.
- The dev server binds `localhost`, so open `http://localhost:5173`, not
  `http://127.0.0.1:5173`.

### What the bridge reads

Nothing is invented. Where a local fact does not exist the endpoint returns the
honest empty shape the handoff already records.

| Endpoint | Source on this machine |
| :--- | :--- |
| `GET /healthz` | process state and `FM_HOME` (the handoff records no shape for this one) |
| `POST /api/session` | local mode: `via: "local"`, an opaque token, `expiresIn: 900`; the app and the sketch both post it, and it is the only accepted method |
| `GET /api/projects` | `data/projects.md` (the `bin/fm-project-mode.sh` registry format), `repo` resolved from each clone's `git remote get-url origin` |
| `GET /api/rooms` | `bin/fm-fleet-snapshot.sh --json` tasks, with `state/*.meta` and `bin/fm-crew-state.sh` as the fallback |
| `GET /api/crews` | `bin/fm-capacity.sh` for capacity, the fleet snapshot for lanes, the backlog for queued work |
| `GET /api/gate` | `no-mistakes status` (initialised, daemon, the active run's id), `no-mistakes runs --limit 1` (last run), `no-mistakes axi status` (its PR, joined on the run's branch and head); a project with no local clone is `not initialised` |
| `GET /api/setup` | harness from `state/*.meta`; default model from `~/.pi/agent/settings.json`, then `~/.commandcode/config.json`; models from the command-code catalogue cache; MCP from `~/.pi/agent/mcp.json`, then `~/.commandcode/mcp.json`; skills from `~/.agents/skills`, `$FM_HOME/skills`, `~/.pi/agent/skills`, `~/.commandcode/skills` |
| `GET /api/github/repos?scope=mine\|discover&q=` | the `gh` CLI already authenticated on this machine; a `gh` failure returns no repositories plus the reason |

`GET /api/rooms` is not in the handoff's GET list (§3) but it is in its full
endpoint table, and it is the app's startup read, so the local build serves it.

Parsing lives in `bridge/data.mjs` (pure, no I/O); file and command reads live in
`bridge/sources.mjs`.

The bridge calls `bash`, `git`, `no-mistakes` and `gh` from the `PATH` it inherits.
Start it from a shell where those resolve (the `npm run bridge` above does on this
machine); a missing binary is reported in the response, never papered over.

### Writes are closed

Every write endpoint answers `501` with a JSON body naming why it is unavailable
in this build:

```json
{"error":"POST /api/projects is not available in the local build",
 "reason":"creating a GitHub repository is a write to the account",
 "endpoint":"POST /api/projects","local":true}
```

| Endpoint | Why it is closed here |
| :--- | :--- |
| `POST /api/projects` | creating a GitHub repository is a write to the account |
| `POST /api/projects/attach` | attaching a repository queues fleet registration |
| `POST /api/projects/fork` | forking creates a repository in the account |
| `POST /api/setup/model` | rewriting the dispatch default mutates fleet config |
| `POST /api/lanes/:id/kill` | killing a lane tears down a running crew |
| `POST /api/rooms/:id/message` | steering a crew writes to a live session |
| `WS /ws` | the live event stream is not wired yet |

The list lives in `WRITE_ENDPOINTS` in [`bridge/server.mjs`](bridge/server.mjs) so
the next task can fill the handlers in against the same routing.

Because `/ws` returns 501, the header badge reads `offline` in local mode. The
Crew, Fleet and Gate views still load real data; only the live event stream is
missing.

### Local auth

There is no oauth2-proxy and no `X-Farm-User` here. `/api/session` names the mode
(`via: "local"`) and every endpoint accepts the request with or without the
token. Nothing enforces `X-Farm-Token`; nothing mints a JWT. Local mode is not a
replacement for the edge, it is the absence of one.

## Build

The deployed build is unchanged.

```bash
VITE_BRIDGE_URL=https://factory.usman-hermes.duckdns.org npm run build:app
# → dist-app/index.html + dist-app/assets/{index-*.js,index-*.css}
```

`ui-app/vite.config.ts` **throws** if `VITE_BRIDGE_URL` is missing or is not a bare
`http(s)://` URL. The absolute same-origin URL is deliberate: it satisfies the
guard, and because Caddy serves both the app and the API under that hostname the
request is still same-origin — no preflight, no credentials flag, no CORS. The
guard is enforced for `vite build` only; `npm run dev` has no use for an absolute
URL because it proxies the bridge onto its own origin.

## Serve

Caddy serves the working tree directly, so a build is the whole deploy:

```
factory.usman-hermes.duckdns.org {
    handle /webhook/github { reverse_proxy 127.0.0.1:8787 }   # HMAC, public
    handle /oauth2/*       { reverse_proxy 127.0.0.1:4180 }   # GitHub SSO
    handle {
        forward_auth 127.0.0.1:4180 { ... }
        handle /api/* {
            reverse_proxy 127.0.0.1:8787 {
                header_up X-Farm-User {http.request.header.X-Auth-Request-User}
            }
        }
        handle /ws {
            reverse_proxy 127.0.0.1:8787 {
                header_up X-Farm-User {http.request.header.X-Auth-Request-User}
            }
        }
        handle {
            root * /home/ubuntu/factory-ui-repo/dist-app
            try_files {path} /index.html
            file_server
        }
    }
}
```

Publish a new build with:

```bash
cd ~/factory-ui-repo && git pull && \
  VITE_BRIDGE_URL=https://factory.usman-hermes.duckdns.org npm run build:app
```

No reload, no restart: the next request serves the new asset hash.

## Why there is no Cloudflare target

Cloudflare Pages was explored and dropped. `factory-ui.pages.dev` was never
created, and a second origin would have cost CORS, a different auth path, and a
session cookie that cannot reach the bridge. The origin list in
`~/.config/factory-bridge/env` now names only this host.

`npx wrangler login` is also unusable on this host: it binds a browser callback
to `localhost:8976` on a headless machine.

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

## Verify the local run

```bash
# 1. the bridge answers on loopback
curl -s http://127.0.0.1:8787/healthz

# 2. the dev proxy reaches the same bridge on the app's origin
curl -s -X POST http://localhost:5173/api/session
curl -s http://localhost:5173/api/crews | head -c 200

# 3. a write is refused with the reason, not silently ignored
curl -s -X POST http://127.0.0.1:8787/api/projects -d '{}'

# 4. the shapes still hold
npm test
```
