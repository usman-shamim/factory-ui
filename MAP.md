# MAP — Factory UI repository index

Directory, module and seam index for this repository. Read this before changing
anything; it exists so a crewmate can cite exact paths instead of scanning.

There is no `AGENTS.md` routing file of our own at the root: the upstream
design-system guide occupies that name. This file is the routing catalogue for
the factory fork, and [`CONTEXT.md`](CONTEXT.md) holds its vocabulary and
decisions.

## Layout

| Path | Role |
|---|---|
| `ui-app/src/App.tsx` | The whole factory shell: session, rooms, projects, stream, theme, responsive drawer |
| `ui-app/src/main.tsx` | Mount point; imports `code-examples/cds-theme.css` |
| `ui-app/index.html` | Vite HTML entry; collapsed-accordion CSS |
| `ui-app/vite.config.ts` | Build config and dev proxy; `root` = `ui-app/`, `outDir` = `../dist-app`, `publicDir: false`, a hard `VITE_BRIDGE_URL` guard for `vite build`, and a `/api` + `/ws` proxy to the local bridge |
| `ui-app/tsconfig.json` | App-only typecheck scope — **the only clean typecheck** |
| `bridge/server.mjs` | Local bridge: Node HTTP routing, the read endpoints, and the 501 wall in front of every write (`WRITE_ENDPOINTS`) |
| `bridge/sources.mjs` | What the bridge reads: Firstmate home files, `bin/fm-*` helpers, `no-mistakes`, the `gh` CLI, local agent config |
| `bridge/data.mjs` | Pure parsers and shape builders (no I/O); the tested contract layer |
| `bridge/test/` | `node:test` suites: parsers, HTTP response shapes, home-to-shape assembly |
| `code-examples/` | Upstream CDS component library (30 components) + design tokens |
| `code-examples/cds-theme.css` | Token source: gray/orange ramps, semantic `--cds-*`, `[data-mode="dark"]` palette |
| `src/index.ts` | Library entry re-exporting `code-examples/*` (not used by the app) |
| `dist-app/` | Build output served by Caddy; regenerated, never hand-edited |
| `FACTORY-UI.md` | Split-plane overview (endpoint table, deployment notes) |
| `AGENTS.md` | **Upstream** CDS design-system guide — not a factory routing file |

## Entrypoints

| Entry | Command |
|---|---|
| Bridge | `npm run bridge` (`127.0.0.1:8787`, reads `FM_HOME`) |
| Dev | `npm run dev` (vite on `localhost:5173`, proxies `/api` and `/ws` to the bridge) |
| Test | `npm test` (`node --test bridge/test/*.test.mjs`) |
| Build app | `VITE_BRIDGE_URL=https://factory.usman-hermes.duckdns.org npm run build:app` |
| Build library | `npm run build` (`tsc -p tsconfig.build.json`) |
| Typecheck app | `npx tsc -p ui-app/tsconfig.json --noEmit` |
| Token audit | `npm run check:tokens` |

## Seams (public interfaces this app depends on)

All are HTTP against the bridge; there is no SDK and no shared types.

| Seam | Shape |
|---|---|
| `GET /healthz` | `{ok, service, mode, home, uptimeMs}` (the handoff records no shape for it) |
| `POST /api/session` | `{token, email, via, expiresIn}`; `via: "local"` in this build, a 15-minute JWT behind the edge on the VM |
| `GET /api/projects` | `{projects: [{name, mode, yolo, description, repo}]}` |
| `POST /api/projects` | `{name, description, visibility}` → creates a GitHub repo, then queues registration; **501 locally** |
| `POST /api/projects/attach` | `{repo: "owner/name"}` → queues registration; **501 locally** |
| `POST /api/projects/fork` | `{repo: "owner/name"}` → forks into the account; **501 locally** |
| `GET /api/rooms` | `{rooms: [{id, task, window, branch, pr, status}]}` |
| `POST /api/rooms/:id/message` | `{text}` → steers the worker, or the Captain when the task is queued; **501 locally** |
| `GET /api/crews` | `{capacity: {freeLanes, lanes, target, reason}, crews: [{id, home, kind, scope, lanes}], queued: [...]}` |
| `GET /api/gate` | `{projects: [{project, initialised, daemon, activeRun, lastRun, error?}]}` |
| `GET /api/setup` | `{harness, defaultModel, models, mcp, skills, counts}` |
| `GET /api/github/repos` | `?scope=mine\|discover&q=` → `{scope, repos: [{fullName, name, private, description, language, updatedAt, stars, url}]}` |
| `POST /api/setup/model` | `{model}` → rewrites the dispatch default; **501 locally** |
| `POST /api/lanes/:id/kill` | `{}` → tears down the lane; **501 locally** |
| `WS /ws` | Frames: `message`, `tool_call`, `tool_result`; the UI drops `hello` and `error`; **501 locally** |
| Header | `X-Farm-Token: <session JWT>` — **not** `Authorization`, which the edge gate consumes; ignored by the local build |
| Env | `VITE_BRIDGE_URL` (required for a build), `VITE_BRIDGE_TOKEN` (legacy fallback only), `FM_HOME` and `FM_BRIDGE_PORT` (bridge) |
| Storage | `localStorage["factory-theme"]` = `light` \| `dark` |

## Factory components outside this repo

Nothing here runs them; they are listed because changing a seam above changes them.

| Component | Where |
|---|---|
| `factory-bridge` | `bridge/` in **this repository** for the local build; `/home/ubuntu/factory-bridge` on `agent-vm`, `127.0.0.1:8787` |
| Firstmate home | `/home/ubuntu/firstmate` (Captain, backlog, `data/projects.md`) |
| Secondmate home | `/home/ubuntu/firstmate-sentinel` (project `sentinal-media`) |
| no-mistakes | `~/.no-mistakes` — one daemon, many repos |
| Caddy | `/etc/caddy/Caddyfile` — serves `dist-app` at `/` and proxies `/api/*`, `/ws` |
| Cloudflare Pages | not created yet; see [`DEPLOY.md`](DEPLOY.md) |

## Gates

There is a test suite now, for the bridge only. The honest gate is:

1. `npm test` → every shape, parser and empty-state assertion passes.
2. `npx tsc -p ui-app/tsconfig.json --noEmit` → must be `rc=0`.
3. `npm run build:app` → must produce `dist-app/index.html` + `dist-app/assets/*`.
4. Grep the built bundle for the behavior you changed (e.g. `localStorage`,
   `max-width: 760px`) — a green build does not prove the code shipped.
5. For a local run, `curl http://localhost:5173/api/crews` must return the live
   shapes through the dev proxy (see [`DEPLOY.md`](DEPLOY.md)).

`npm run typecheck` (repo-wide) **fails by design**: `code-examples/createClaudeMainWindow.ts`
imports `electron`, which was deliberately removed as a 200 MB devDependency and
is never bundled. Do not "fix" it by reinstalling electron.

## Known gaps

- The bridge's write endpoints and `WS /ws` are closed with 501; the live event
  stream, project creation/attach/fork, lane kill and crew messaging are unwired.
- Secondmate crews appear only when the fleet snapshot's `secondmate_current`
  records name a readable home; none are registered on this machine.
- Repo-wide typecheck is red (see above).

Last verified: 2026-11-18 against `b28ad08` plus the local bridge.
