# Factory UI

The web console for a [Firstmate](https://github.com/kunchenguid/firstmate) software
factory: one place to watch autonomous coding crews work, steer them, and manage the
GitHub projects they work on.

A **room** is a crewmate lane (`fm-<task>`). The stream shows its live tool calls,
assistant turns and diffs, exactly as the crewmate produces them.

## What it does

- **Projects** — list registered projects, create a GitHub repository (private or
  public), or adopt an existing one. Registration stays with the factory's Captain,
  so a new repo shows *queued for the Captain* until the registry confirms it.
- **Rooms** — one per active task, with branch and pull-request status.
- **Live stream** — WebSocket frames from the bridge: messages, tool calls, diffs.
  Tool output collapses to a single line so a burst of `bash`/`read` cannot bury
  the assistant's replies.
- **Steer** — send an instruction to a running crewmate, or to the Captain when the
  task is still queued.
- **Theme** — light and dark, persisted per browser.

## Architecture

Split plane: this app is static, and a small bridge on the factory host owns all
privileged work.

```
browser ──HTTPS──► edge (GitHub SSO) ──► static app
                          └───────────► bridge ──► firstmate ──► crewmates
```

The app never holds a long-lived credential. The edge authenticates the user, the
bridge mints a short-lived session JWT, and the app sends it as `X-Farm-Token`
(`Authorization` belongs to the edge).

See [`MAP.md`](MAP.md) for paths and the exact request/response seams, and
[`CONTEXT.md`](CONTEXT.md) for the vocabulary and the design decisions.

## Run it

Locally the console runs against this machine's Firstmate home. Two commands, one
origin:

```bash
npm install
npm run bridge   # terminal 1: the bridge on 127.0.0.1:8787
npm run dev      # terminal 2: the app on http://localhost:5173
```

`npm run dev` proxies `/api` and `/ws` to the bridge, so the app keeps relative
fetch paths and no CORS appears. Do not set `VITE_BRIDGE_URL` for the dev server;
the deployed build below still requires it.

```bash
VITE_BRIDGE_URL=https://your-bridge.example npm run build:app # → dist-app/
```

The variable is required for a build — `ui-app/vite.config.ts` refuses to build without
a bare `http(s)://` URL, because a mis-pasted markdown autolink otherwise produces a
bundle that calls an unreachable host.

Typecheck the app and test the bridge:

```bash
npx tsc -p ui-app/tsconfig.json --noEmit
npm test
```

`npm run typecheck` (repo-wide) fails on `code-examples/createClaudeMainWindow.ts`,
which imports `electron`. That dependency was removed as a 200 MB dev dependency and
is never bundled; the upstream file is left untouched.

Deployment targets and their constraints are in [`DEPLOY.md`](DEPLOY.md).

## Built on open-claude-ui

The component library, design tokens and interaction physics come from
[`Caho1/open-claude-ui`](https://github.com/Caho1/open-claude-ui), a clean-room
reimplementation of the Claude Design System. Its `code-examples/` directory is
vendored here unmodified, and its Chinese README is preserved at
[`docs/UPSTREAM-README.zh.md`](docs/UPSTREAM-README.zh.md).

What this repository adds is the application shell in `ui-app/` — session handling,
rooms, projects, the WebSocket stream and the theme — plus the local bridge in
`bridge/` that serves those read models from a Firstmate home on this machine.

## License

MIT — see [LICENSE](LICENSE). Upstream copyright (c) 2026 Caho1 is retained.
