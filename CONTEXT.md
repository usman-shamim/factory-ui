# CONTEXT — Factory UI domain vocabulary and decisions

What the words mean here, and why the architecture is shaped the way it is.
Pair this with [`MAP.md`](MAP.md) for paths and seams.

## Vocabulary

| Term | Meaning |
|---|---|
| **Project** | A GitHub repository the factory works on, registered in Firstmate's `data/projects.md`. Carries a delivery mode and an optional `+yolo` merge flag. |
| **Task** | A unit of queued work, owned by `tasks-axi` in `data/backlog.md`. A task id becomes the branch and the tmux window name. |
| **Ship** | A task whose crewmate finishes by pushing a branch and opening a PR. |
| **Crewmate** | The agent that does the work, spawned into an isolated worktree. |
| **Firstmate / Captain** | The supervising agent that decides what to dispatch and steers crewmates. |
| **Secondmate** | A crewmate with its own isolated Firstmate home and charter — *not* a second architecture. Idle by default; acts only on routed work. |
| **Lane** | A concurrency slot. Capacity is a hard, code-enforced number (`config/lane-capacity`), currently 2 with `admit-spawns`. |
| **Room** | The UI's view of a task: a tmux window `fm-<id>` plus its branch, PR and status. |
| **Treehouse** | The worktree provider. Each ship gets a disposable checkout under `.treehouse/`. |
| **Gate** | The `no-mistakes` review pipeline: a local Git proxy that validates before pushing. |
| **Lane kill** | Releasing a lane and stopping that crew. Not a merge, not a rollback. |

## Decisions

**1. Queuing never dispatches.** The bridge writes a task and nudges the Captain;
it never spawns a crewmate. This keeps the lane cap authoritative, so a webhook
cannot outrun the budget. Any UI claim that a queued task is "running" is a bug.

**2. Registration is Captain-owned.** The UI creates the GitHub repository (via
`gh`, deterministic and returns the URL) but never writes `data/projects.md`.
That file belongs to the `project-management` skill. A new repo therefore shows
`queued for the Captain` until the registry confirms it.

**3. Additive beats destructive.** When adding a field to a contract, extend it;
never replace the existing shape. The `/health` slice that removed `live_source`
and deleted the assertions guarding it was reverted to `+1` line with zero
deletions. **A deleted assertion is a finding, not a fix.**

**4. One origin beats two.** The default deployment is Caddy serving `dist-app`
at `/` with `/api/*` and `/ws` proxied to the bridge, so no CORS and no
cross-site cookie rules apply. Cloudflare Pages is the alternate target and
costs CORS plus a different auth path.

**5. The edge is the credential.** `oauth2-proxy` (GitHub SSO) gates the site;
the bridge mints a 15-minute JWT for the UI. `Authorization` is consumed by the
edge, which is why the app token travels in `X-Farm-Token`.

**6. Tokens persist per browser.** `localStorage`, not `sessionStorage`: the
Sentinel lesson was that per-tab storage means re-entering a token per tab.

**7. The design system is the theme.** `cds-theme.css` already ships the dark
palette as `[data-mode="dark"]`. Referencing variable names that do not exist
(`--cds-bg-app`, `--cds-text`) silently falls back to light hexes and kills
theming — always check the token actually exists before using it.

**8. One daemon, many repos.** `no-mistakes` is a single local daemon keyed by
repository. Modelling it as "one daemon per project" is wrong.

**9. Memory is the real ceiling.** The host has ~1.9 GB usable; an idle
secondmate costs nothing, but every live captain is ~186 MB and a crewmate is
the same class. Two lanes plus three homes does not fit.

## How to verify a claim about this system

Do not trust prose. `bin/fm-fleet-snapshot.sh --json` on the host is the
authoritative fleet state (`id`, `project`, `mode`, `branch`, `current_state`,
`pr`, `secondmate_projects`, `actions`). `GET /openapi.json` on the sentinel API
is authoritative for its routes. Both beat any document, including this one.
