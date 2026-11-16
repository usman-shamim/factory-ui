# Factory UI — split-plane app

Split-plane web UI for the Firstmate software factory. Rooms map to Firstmate
crewmate lanes (`fm-<task>`), and the event stream shows live tool calls and diffs.

Built on [open-claude-ui](https://github.com/Caho1/open-claude-ui), which supplies
the Claude-style message bubbles and the streaming diff viewer.

Paths and seams: [`MAP.md`](MAP.md). Vocabulary and decisions: [`CONTEXT.md`](CONTEXT.md).
Deployment: [`DEPLOY.md`](DEPLOY.md).

## What it talks to

`factory-bridge` on the VM, through its public HTTPS endpoint:

| Route | Purpose |
| --- | --- |
| `POST /api/session` | Exchanges the edge identity for a 15-minute session JWT |
| `GET /api/projects` | Registered projects, with the repo resolved from each clone's origin |
| `POST /api/projects` | Creates a GitHub repository, then queues registration for the Captain |
| `POST /api/projects/attach` | Adopts an existing `owner/name`, then queues registration |
| `GET /api/rooms` | Lists rooms (task, worktree branch, PR, status) |
| `POST /api/rooms/:id/message` | Steers a worker, or the Captain when the task is queued |
| `WS /ws` | Live tool calls, message turns, and diffs |

Authentication is the **edge gate**, not a secret in the bundle: `oauth2-proxy`
(GitHub SSO) protects the whole site, and the bridge mints a short-lived session
JWT which the app sends as `X-Farm-Token`. `Authorization` is deliberately not
used — the edge consumes it.

`VITE_BRIDGE_TOKEN` exists only as a legacy fallback and must **not** be set for a
build. A static token in a static bundle is a published credential.

The terminal (`ttyd`, port 7681) is deliberately never proxied publicly.

## Deploy

```bash
VITE_BRIDGE_URL=https://factory.usman-hermes.duckdns.org npm run build:app
```

The variable is required: `ui-app/vite.config.ts` throws without a bare
`http(s)://` URL.

- **Caddy on the VM (live)** — serves `dist-app` at `/` and proxies `/api/*` and
  `/ws`. No deploy step beyond building.
- **Cloudflare Pages (not created)** — build command `npm run build:app`, output
  `dist-app`, `VITE_BRIDGE_URL` as an environment variable. Details, including
  why Vercel is not used here, are in [`DEPLOY.md`](DEPLOY.md).

## Local build check

```bash
npm install
VITE_BRIDGE_URL=https://example.invalid npm run build:app
npx tsc -p ui-app/tsconfig.json --noEmit
```

The VM itself never runs a dev server: the split plane keeps frontend RAM at zero
there.
