# Factory UI — split-plane app

Split-plane web UI for the Firstmate software factory. Rooms map to Firstmate
crewmate lanes (`fm-<task>`), and the event stream shows live tool calls and diffs.

Built on [open-claude-ui](https://github.com/Caho1/open-claude-ui), which supplies
the Claude-style message bubbles and the streaming diff viewer.

## What it talks to

`factory-bridge` on the VM, through its public HTTPS endpoint:

| Route | Purpose |
| --- | --- |
| `GET /api/rooms` | Lists rooms (task, worktree branch, PR, status) |
| `POST /api/rooms/:id/message` | Steers a worker, or the Captain when the task is queued |
| `WS /ws` | Live tool calls, message turns, and diffs |

`/api/*` and `/ws` require a Bearer token. The terminal (`ttyd`, port 7681) is
deliberately never proxied publicly.

## Deploy

Build-time environment variables:

```bash
VITE_BRIDGE_URL=https://factory.usman-hermes.duckdns.org
VITE_BRIDGE_TOKEN=<the BRIDGE_AUTH_TOKEN from the VM>
```

### Cloudflare Pages

- Framework preset: **Vite**
- Build command: `npm run build:app`
- Output directory: `dist-app`
- Add both variables under Settings -> Environment variables (Production and Preview)

### Vercel

- Framework preset: **Vite**
- Build command: `npm run build:app`
- Output directory: `dist-app`
- Add both variables under Settings -> Environment Variables

## Local build check

```bash
npm install
VITE_BRIDGE_URL=https://example.invalid VITE_BRIDGE_TOKEN=x npm run build:app
```

The VM itself never runs a dev server: the split plane keeps frontend RAM at zero
there.
