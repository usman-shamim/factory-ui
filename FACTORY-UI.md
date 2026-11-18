# Factory UI — split-plane app

Split-plane web UI for the Firstmate software factory. Rooms map to Firstmate
crewmate lanes (`fm-<task>`), and the event stream shows live tool calls and diffs.

Built on [open-claude-ui](https://github.com/Caho1/open-claude-ui), which supplies
the Claude-style message bubbles and the streaming diff viewer.

Each fact has one owner document; this file only frames the split.

| Question | Owner |
| --- | --- |
| Every route and its exact shape | [`MAP.md`](MAP.md) |
| Vocabulary and architecture decisions | [`CONTEXT.md`](CONTEXT.md) |
| Running it — local bridge and dev server, host deploy, gates | [`DEPLOY.md`](DEPLOY.md) |

## The split

```
browser ──HTTPS──► edge (GitHub SSO) ──► static app
                          └───────────► bridge ──► firstmate ──► crewmates
```

The app is static and never holds a long-lived credential. On the factory host
`oauth2-proxy` gates the site and the bridge mints a short-lived session JWT,
which the app sends as `X-Farm-Token` — `Authorization` belongs to the edge.
`VITE_BRIDGE_TOKEN` exists only as a legacy fallback and must **not** be set for a
build: a static token in a static bundle is a published credential.

The terminal (`ttyd`, port 7681) is deliberately never proxied publicly.

## Local run

The bridge lives in [`bridge/`](bridge/) in this repository, so the console also
runs on a workstation against that machine's Firstmate home: `npm run bridge` and
`npm run dev`, one origin, no edge. In that mode every write endpoint and `WS /ws`
answer `501` with the reason. Commands, sources and the closed-endpoint list are
in [`DEPLOY.md`](DEPLOY.md).

The VM itself never runs a dev server: the split plane keeps frontend RAM at zero
there.
