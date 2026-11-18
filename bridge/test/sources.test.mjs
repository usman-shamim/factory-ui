/**
 * Assembly contracts: a real (temporary) Firstmate home, real file reads, and a
 * fake command runner standing in for `bin/fm-*`, `no-mistakes`, `git` and `gh`.
 *
 * This is where the file-to-shape wiring is pinned: a project clone under
 * `projects/`, lanes from the fleet snapshot, `state/*.meta` as the fallback,
 * queued work from the backlog, and the gate's not-initialised record. No test
 * here shells out to the machine or touches the network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createSources } from "../sources.mjs";

function response({ ok = true, stdout = "", stderr = "", code = 0 } = {}) {
  return { ok, code, stdout, stderr, error: ok ? null : stderr || "command failed" };
}

/**
 * A runner that answers the commands the bridge knows how to ask, and fails
 * loudly (but observably) on anything else.
 */
function fakeRunner(handlers) {
  const calls = [];
  const run = async (command, args, options = {}) => {
    const line = `${command} ${args.join(" ")}`.trim();
    calls.push({ line, cwd: options.cwd ?? null });
    for (const [pattern, handler] of handlers) {
      if (pattern.test(line)) {
        return typeof handler === "function" ? handler({ command, args, options }) : response(handler);
      }
    }
    return response({ ok: false, stderr: `unexpected command: ${line}` });
  };
  return { run, calls };
}

const keys = (object) => Object.keys(object).sort();

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "factory-bridge-test-"));
}

async function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
}

const SNAPSHOT = {
  schema: "fm-fleet-snapshot.v1",
  fm_home: "/tmp/fm-home",
  tasks: [
    {
      id: "factory-local-bridge",
      kind: "ship",
      branch: "fm/factory-local-bridge",
      project: "/tmp/fm-home/projects/factory",
      endpoint: { target: "default:wA:p2" },
      current_state: { state: "working", source: "pane" },
      pr: { url: null, source: "absent" },
      backlog: { title: "Stand up the factory console locally", pr_url: null },
    },
  ],
  backlog: {
    records: [
      { id: "factory-local-bridge", title: "Stand up the factory console locally", repo: "factory", state: "in_flight", since: "2026-11-18", pr_url: null, blocked_reason: null },
      { id: "factory-design-stitch", title: "Migrate the UI to the stitch design pack", repo: "factory", state: "queued", since: "2026-11-18", pr_url: null, blocked_reason: "factory-local-bridge" },
    ],
  },
  secondmate_current: { records: [] },
};

test("an empty home yields every documented empty state", async () => {
  const fmHome = await tempHome();
  const home = await tempHome();
  const { run } = fakeRunner([]);
  const sources = createSources({ fmHome, home, run });

  assert.deepEqual(await sources.projects(), []);
  const crews = await sources.crews();
  assert.deepEqual(keys(crews.capacity), ["freeLanes", "lanes", "reason", "target"]);
  assert.equal(crews.capacity.freeLanes, null);
  assert.equal(crews.capacity.lanes, null);
  assert.equal(typeof crews.capacity.reason, "string");
  assert.deepEqual(crews.crews, [
    { id: path.basename(fmHome), home: fmHome, kind: "primary", scope: null, lanes: [] },
  ]);
  assert.deepEqual(crews.queued, []);
  assert.deepEqual(await sources.gate(), { projects: [] });
  assert.deepEqual(await sources.rooms(), { rooms: [] });
  assert.deepEqual(await sources.setup(), {
    harness: "unknown",
    defaultModel: null,
    models: [],
    mcp: [],
    skills: [],
    counts: { models: 0, mcp: 0, skills: 0 },
  });
});

test("a populated home is assembled from files, the snapshot and the helpers", async () => {
  const fmHome = await tempHome();
  const home = await tempHome();
  await writeFiles(fmHome, {
    "data/projects.md": [
      "# Projects",
      "",
      "- factory [no-mistakes-prod-only] - Factory Console: web control plane (added 2026-11-18)",
      "- sentinal-media [no-mistakes] - Sentinel content platform (added 2026-11-15)",
    ].join("\n"),
    "data/backlog.md": "# Backlog\n\n## Queued\n- [ ] factory-design-stitch - Migrate the UI (repo: factory) (since 2026-11-18)\n",
    "state/factory-local-bridge.meta": [
      "project=/tmp/fm-home/projects/factory",
      "branch=fm/factory-local-bridge",
      "harness=pi",
      "window=default:wA:p2",
      "endpoint_task_id=factory-local-bridge",
    ].join("\n"),
    "state/other-task.meta": "project=/tmp/fm-home/projects/factory\nbranch=fm/other\nharness=pi\n",
  });
  await fs.mkdir(path.join(fmHome, "projects", "factory"), { recursive: true });

  await writeFiles(home, {
    ".pi/agent/settings.json": JSON.stringify({ defaultModel: "deepseek/deepseek-v4.1-flash" }),
    ".pi/agent/mcp.json": JSON.stringify({
      mcpServers: { context7: { url: "https://mcp.context7.com/mcp" }, local: { command: "node", args: ["server.mjs"] } },
    }),
    ".commandcode/cache/model-catalog/v1/catalog-abc.json": JSON.stringify({
      fetchedAt: 1794983791738,
      body: {
        data: [
          { id: "deepseek/deepseek-v4-pro", display: { group: "Open Source", description: "long-context reasoning" } },
          { id: "claude-sonnet-5", display: { group: "Anthropic", description: "balanced" } },
        ],
      },
    }),
    ".agents/skills/agent-reach/SKILL.md": "# agent-reach\n",
    ".agents/skills/code-review/SKILL.md": "# code-review\n",
    ".pi/agent/skills/learn/SKILL.md": "# learn\n",
  });

  const { run, calls } = fakeRunner([
    [
      /bash .*\/bin\/fm-capacity\.sh/,
      { stdout: "capacity: free_lanes=2 reason=ok lanes=1 target=2 secondmates=0\n" },
    ],
    [/bash .*\/bin\/fm-fleet-snapshot\.sh --json/, { stdout: JSON.stringify(SNAPSHOT) }],
    [/bash .*\/bin\/fm-crew-state\.sh factory-local-bridge/, { stdout: "state: working · source: run-step · review\n" }],
    [/^git remote get-url origin/, { stdout: "https://github.com/usman-shamim/factory-ui.git\n" }],
    [
      /^no-mistakes status/,
      {
        stdout: [
          "    repo:  /tmp/fm-home/projects/factory",
          "  remote:  https://github.com/usman-shamim/factory-ui.git",
          "    gate:  /home/usman/.no-mistakes/repos/6c01e655b444.git",
          "  daemon:  ● running",
          "",
          "  no active run",
        ].join("\n"),
      },
    ],
    [
      /^no-mistakes runs --limit 1/,
      { stdout: "  completed    fm/factory-local-bridge   c78fe2eb  2026-11-15 03:59\n" },
    ],
    [
      /^no-mistakes axi status/,
      {
        stdout: [
          "runs[1]{id,branch,status,head,pr}:",
          '  "01M70MTY424YSWP91A6MG10T35",fm/factory-local-bridge,completed,c78fe2eb,"https://github.com/usman-shamim/factory-ui/pull/11"',
        ].join("\n"),
      },
    ],
    [
      /^gh repo list/,
      {
        stdout: JSON.stringify([
          {
            name: "factory-ui",
            nameWithOwner: "usman-shamim/factory-ui",
            isPrivate: false,
            description: "Web console",
            primaryLanguage: { name: "TypeScript" },
            updatedAt: "2026-11-16T14:39:24Z",
            stargazerCount: 0,
            url: "https://github.com/usman-shamim/factory-ui",
          },
        ]),
      },
    ],
    [
      /^gh search repos factory console/,
      { stdout: JSON.stringify([{ fullName: "a/b", name: "b", isPrivate: false, language: "Go", updatedAt: "2026-01-01T00:00:00Z", stargazersCount: 3, url: "https://github.com/a/b" }]) },
    ],
  ]);

  const sources = createSources({ fmHome, home, run });

  const projects = await sources.projects();
  assert.deepEqual(projects.map((project) => [project.name, project.repo]), [
    ["factory", "usman-shamim/factory-ui"],
    ["sentinal-media", null],
  ]);

  const crews = await sources.crews();
  assert.deepEqual(crews.capacity, { freeLanes: 2, lanes: 1, target: 2, reason: "ok" });
  assert.deepEqual(crews.crews[0].lanes, [
    {
      id: "factory-local-bridge",
      project: "factory",
      state: "working",
      branch: "fm/factory-local-bridge",
      pr: null,
      window: "default:wA:p2",
    },
  ]);
  assert.deepEqual(crews.queued, [
    {
      id: "factory-design-stitch",
      title: "Migrate the UI to the stitch design pack",
      repo: "factory",
      state: "queued",
      blocked: "factory-local-bridge",
      since: "2026-11-18",
      pr: null,
    },
  ]);

  const rooms = await sources.rooms();
  assert.deepEqual(rooms.rooms, [
    {
      id: "factory-local-bridge",
      task: "Stand up the factory console locally",
      window: "default:wA:p2",
      branch: "fm/factory-local-bridge",
      pr: null,
      status: "working",
    },
  ]);

  const gate = await sources.gate();
  assert.deepEqual(gate.projects[0], {
    project: "factory",
    initialised: true,
    daemon: "● running",
    activeRun: null,
    lastRun: {
      state: "completed",
      branch: "fm/factory-local-bridge",
      commit: "c78fe2eb",
      when: "2026-11-15 03:59",
      pr: "https://github.com/usman-shamim/factory-ui/pull/11",
    },
  });
  assert.deepEqual(gate.projects[1], {
    project: "sentinal-media",
    initialised: false,
    daemon: null,
    activeRun: null,
    lastRun: null,
    error: "not initialised",
  });

  const setup = await sources.setup();
  assert.equal(setup.harness, "pi", "harness comes from the task meta records");
  assert.equal(setup.defaultModel, "deepseek/deepseek-v4.1-flash");
  assert.deepEqual(setup.models.map((model) => model.group), ["Open Source", "Anthropic"]);
  assert.deepEqual(setup.mcp, [
    { name: "context7", target: "https://mcp.context7.com/mcp" },
    { name: "local", target: "node server.mjs" },
  ]);
  assert.deepEqual(
    setup.skills,
    [
      { name: "agent-reach", source: "agents" },
      { name: "code-review", source: "agents" },
      { name: "learn", source: "pi" },
    ],
  );
  assert.deepEqual(setup.counts, { models: 2, mcp: 2, skills: 3 });

  const mine = await sources.repos("mine");
  assert.equal(mine.scope, "mine");
  assert.equal(mine.repos[0].fullName, "usman-shamim/factory-ui");
  assert.equal(mine.repos[0].language, "TypeScript");

  const discover = await sources.repos("discover", "factory console");
  assert.equal(discover.repos[0].stars, 3);
  assert.equal(discover.repos[0].language, "Go");

  assert.equal(
    calls.some((call) => /^no-mistakes status$/.test(call.line) && call.cwd === path.join(fmHome, "projects", "factory")),
    true,
    "the gate is read from the project clone",
  );
});

test("lanes fall back to state/*.meta when the snapshot is unavailable", async () => {
  const fmHome = await tempHome();
  const home = await tempHome();
  await writeFiles(fmHome, {
    "state/factory-local-bridge.meta": [
      "project=/tmp/fm-home/projects/factory",
      "branch=fm/factory-local-bridge",
      "harness=pi",
      "window=default:wA:p2",
      "endpoint_task_id=factory-local-bridge",
    ].join("\n"),
  });

  const { run } = fakeRunner([
    [/bash .*\/bin\/fm-capacity\.sh/, { ok: false, stderr: "no helper" }],
    [/bash .*\/bin\/fm-fleet-snapshot\.sh --json/, { ok: false, stderr: "no helper" }],
    [/bash .*\/bin\/fm-crew-state\.sh factory-local-bridge/, { stdout: "state: paused · source: status-log · waiting\n" }],
  ]);

  const sources = createSources({ fmHome, home, run });
  const crews = await sources.crews();
  assert.deepEqual(crews.crews[0].lanes, [
    {
      id: "factory-local-bridge",
      project: "factory",
      state: "paused",
      branch: "fm/factory-local-bridge",
      pr: null,
      window: "default:wA:p2",
    },
  ]);
  assert.equal(crews.capacity.reason, "no helper", "a broken helper is reported, not silently zeroed");
});

test("queued work falls back to data/backlog.md when the snapshot is unavailable", async () => {
  const fmHome = await tempHome();
  const home = await tempHome();
  await writeFiles(fmHome, {
    "data/backlog.md": [
      "# Backlog",
      "## In flight",
      "- [ ] running-task - Already dispatched (repo: factory) (since 2026-11-18)",
      "## Queued",
      "- [ ] queued-task - Waiting for a lane blocked-by: running-task (repo: factory) (since 2026-11-18)",
    ].join("\n"),
  });

  const { run } = fakeRunner([[/bash .*bin\/fm-fleet-snapshot\.sh/, { ok: false, stderr: "no helper" }]]);
  const sources = createSources({ fmHome, home, run });
  const crews = await sources.crews();
  assert.deepEqual(crews.queued.map((item) => item.id), ["queued-task"]);
  assert.equal(crews.queued[0].blocked, "running-task");
  assert.equal(crews.queued[0].title, "Waiting for a lane", "the blocker token never leaks into the task label");
});

test("the gate pairs a PR with the run of the same head and branch, never by table position", async () => {
  const fmHome = await tempHome();
  const home = await tempHome();
  await writeFiles(fmHome, {
    "data/projects.md": "- factory [no-mistakes] - Console (added 2026-11-18)\n",
  });
  await fs.mkdir(path.join(fmHome, "projects", "factory"), { recursive: true });

  const { run } = fakeRunner([
    [
      /^no-mistakes status/,
      { stdout: ["    repo:  /tmp/fm-home/projects/factory", "  daemon:  ● running", "", "  no active run"].join("\n") },
    ],
    [/^no-mistakes runs --limit 1/, { stdout: "  completed    fm/factory-local-bridge   c78fe2eb  2026-11-15 03:59\n" }],
    [
      /^no-mistakes axi status/,
      {
        stdout: [
          "runs[2]{id,branch,status,head,pr}:",
          '  "01M7NEWER",fm/factory-design-stitch,running,9a1b2c3d,"https://github.com/usman-shamim/factory-ui/pull/99"',
          '  "01M7OLDER",fm/factory-local-bridge,completed,c78fe2eb,"https://github.com/usman-shamim/factory-ui/pull/11"',
        ].join("\n"),
      },
    ],
  ]);

  const sources = createSources({ fmHome, home, run });
  const [row] = (await sources.gate()).projects;
  assert.equal(row.lastRun.commit, "c78fe2eb");
  assert.equal(row.lastRun.pr, "https://github.com/usman-shamim/factory-ui/pull/11");
});

test("the gate leaves the PR null when no axi row is the run that `runs` reported", async () => {
  const fmHome = await tempHome();
  const home = await tempHome();
  await writeFiles(fmHome, {
    "data/projects.md": "- factory [no-mistakes] - Console (added 2026-11-18)\n",
  });
  await fs.mkdir(path.join(fmHome, "projects", "factory"), { recursive: true });

  const { run } = fakeRunner([
    [
      /^no-mistakes status/,
      { stdout: ["    repo:  /tmp/fm-home/projects/factory", "  daemon:  ● running", "", "  no active run"].join("\n") },
    ],
    [/^no-mistakes runs --limit 1/, { stdout: "  completed    fm/factory-local-bridge   c78fe2eb  2026-11-15 03:59\n" }],
    [
      /^no-mistakes axi status/,
      {
        stdout: [
          "runs[1]{id,branch,status,head,pr}:",
          '  "01M7NEWER",fm/factory-design-stitch,running,9a1b2c3d,"https://github.com/usman-shamim/factory-ui/pull/99"',
        ].join("\n"),
      },
    ],
  ]);

  const sources = createSources({ fmHome, home, run });
  const [row] = (await sources.gate()).projects;
  assert.equal(row.lastRun.pr, null, "another run's PR is not borrowed");
});

test("skills are listed in name order, not in filesystem order", async () => {
  const fmHome = await tempHome();
  const home = await tempHome();
  await writeFiles(home, {
    ".agents/skills/zebra/SKILL.md": "# zebra\n",
    ".agents/skills/alpha/SKILL.md": "# alpha\n",
    ".agents/skills/middle/SKILL.md": "# middle\n",
  });

  const { run } = fakeRunner([]);
  const sources = createSources({ fmHome, home, run });
  const skills = (await sources.setup()).skills;
  assert.deepEqual(skills.map((skill) => skill.name), ["alpha", "middle", "zebra"]);
});

test("an uninitialised clone is the not-initialised record, not an error", async () => {
  const fmHome = await tempHome();
  const home = await tempHome();
  await writeFiles(fmHome, {
    "data/projects.md": "- fresh-repo [no-mistakes] - Not gated yet (added 2026-11-18)\n",
  });
  await fs.mkdir(path.join(fmHome, "projects", "fresh-repo"), { recursive: true });

  const { run } = fakeRunner([
    [/^no-mistakes status/, { ok: true, stdout: "repo not initialized (run 'no-mistakes init' first)\n" }],
  ]);

  const sources = createSources({ fmHome, home, run });
  assert.deepEqual((await sources.gate()).projects, [
    { project: "fresh-repo", initialised: false, daemon: null, activeRun: null, lastRun: null, error: "not initialised" },
  ]);
});

test("a missing no-mistakes binary reports the failure instead of claiming a gate", async () => {
  const fmHome = await tempHome();
  const home = await tempHome();
  await writeFiles(fmHome, {
    "data/projects.md": "- factory [no-mistakes] - Console (added 2026-11-18)\n",
  });
  await fs.mkdir(path.join(fmHome, "projects", "factory"), { recursive: true });

  const { run } = fakeRunner([
    [/^no-mistakes status/, { ok: false, code: 127, stderr: "" }],
  ]);

  const sources = createSources({ fmHome, home, run });
  const [row] = (await sources.gate()).projects;
  assert.equal(row.initialised, false);
  assert.equal(typeof row.error, "string");
  assert.ok(row.error.length > 0, "the row says why it could not read the gate");
});

test("gh failures return the empty repository list plus the reason", async () => {
  const fmHome = await tempHome();
  const home = await tempHome();
  const { run } = fakeRunner([
    [/^gh repo list/, { ok: false, stderr: "gh: not logged in to any GitHub hosts\n" }],
  ]);

  const sources = createSources({ fmHome, home, run });
  assert.deepEqual(await sources.repos("mine"), {
    scope: "mine",
    repos: [],
    error: "github unavailable: gh: not logged in to any GitHub hosts",
  });
});

test("session names the local mode and never requires an edge", async () => {
  const fmHome = await tempHome();
  const home = await tempHome();
  const { run } = fakeRunner([[/* no git identity */ /^git config --get user\.email/, { ok: false, code: 1 }]]);

  const sources = createSources({ fmHome, home, run });
  const session = await sources.session();
  assert.equal(session.via, "local");
  assert.equal(session.expiresIn, 900);
  assert.equal(session.email, "local@localhost");
  assert.match(session.token, /^local-/);
});
