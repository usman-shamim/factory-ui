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
| `ui-app/vite.config.ts` | Build config; `root` = `ui-app/`, `outDir` = `../dist-app`, `publicDir: false`, and a hard `VITE_BRIDGE_URL` guard |
| `ui-app/tsconfig.json` | App-only typecheck scope — **the only clean typecheck** |
| `code-examples/` | Upstream CDS component library (30 components) + design tokens |
| `code-examples/cds-theme.css` | Token source: gray/orange ramps, semantic `--cds-*`, `[data-mode="dark"]` palette |
| `src/index.ts` | Library entry re-exporting `code-examples/*` (not used by the app) |
| `dist-app/` | Build output served by Caddy; regenerated, never hand-edited |
| `wrangler.jsonc` | Workers-assets config (`name: factory-ui`, directory `./dist-app`) |
| `FACTORY-UI.md` | Split-plane overview (endpoint table, deployment notes) |
| `AGENTS.md` | **Upstream** CDS design-system guide — not a factory routing file |

## Entrypoints

| Entry | Command |
|---|---|
| Dev | `npm run dev` (vite, `ui-app/`) |
| Build app | `VITE_BRIDGE_URL=https://factory.usman-hermes.duckdns.org npm run build:app` |
| Build library | `npm run build` (`tsc -p tsconfig.build.json`) |
| Typecheck app | `npx tsc -p ui-app/tsconfig.json --noEmit` |
| Token audit | `npm run check:tokens` |

## Seams (public interfaces this app depends on)

All are HTTP against the bridge; there is no SDK and no shared types.

| Seam | Shape |
|---|---|
| `POST /api/session` | `{token, email, via, expiresIn}`; mints a 15-minute JWT after the edge authenticates |
| `GET /api/projects` | `{projects: [{name, mode, yolo, description, repo}]}` |
| `POST /api/projects` | `{name, description, visibility}` → creates a GitHub repo, then queues registration |
| `POST /api/projects/attach` | `{repo: "owner/name"}` → queues registration |
| `GET /api/rooms` | `{rooms: [{id, task, window, branch, pr, status}]}` |
| `POST /api/rooms/:id/message` | `{text}` → steers the worker, or the Captain when the task is queued |
| `WS /ws` | Frames: `message`, `tool_call`, `tool_result`; the UI drops `hello` and `error` |
| Header | `X-Farm-Token: <session JWT>` — **not** `Authorization`, which the edge gate consumes |
| Env | `VITE_BRIDGE_URL` (required), `VITE_BRIDGE_TOKEN` (legacy fallback only) |
| Storage | `localStorage["factory-theme"]` = `light` \| `dark` |

## Factory components outside this repo

Nothing here runs them; they are listed because changing a seam above changes them.

| Component | Where |
|---|---|
| `factory-bridge` | `/home/ubuntu/factory-bridge` on `agent-vm`, `127.0.0.1:8787` |
| Firstmate home | `/home/ubuntu/firstmate` (Captain, backlog, `data/projects.md`) |
| Secondmate home | `/home/ubuntu/firstmate-sentinel` (project `sentinal-media`) |
| no-mistakes | `~/.no-mistakes` — one daemon, many repos |
| Caddy | `/etc/caddy/Caddyfile` — serves `dist-app` at `/` and proxies `/api/*`, `/ws` |
| Cloudflare Pages | not created yet; see [`DEPLOY.md`](DEPLOY.md) |

## Gates

There is no test suite in this repository. The honest gate is:

1. `npx tsc -p ui-app/tsconfig.json --noEmit` → must be `rc=0`.
2. `npm run build:app` → must produce `dist-app/index.html` + `dist-app/assets/*`.
3. Grep the built bundle for the behavior you changed (e.g. `localStorage`,
   `max-width: 760px`) — a green build does not prove the code shipped.

`npm run typecheck` (repo-wide) **fails by design**: `code-examples/createClaudeMainWindow.ts`
imports `electron`, which was deliberately removed as a 200 MB devDependency and
is never bundled. Do not "fix" it by reinstalling electron.

## Known gaps

- No `/api/crews` or `/api/gate` endpoints, so no Fleet or Review Gate view in the app.
- No project fork endpoint (`POST /api/projects/fork`) yet.
- Cloudflare Pages is configured in `wrangler.jsonc` but no Pages project exists.
- Repo-wide typecheck is red (see above).

Last verified: 2026-11-16 against commit `07d9dfb`.
