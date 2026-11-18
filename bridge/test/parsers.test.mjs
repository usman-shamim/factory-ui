/**
 * Parser contracts, pinned to samples recorded on this machine.
 *
 * Each sample is a real reading from the fleet: the capacity summary, a
 * registered project line, a `no-mistakes status` block, the `runs` table and
 * the `axi status` run table. A format change upstream should fail here first.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  catalogModels,
  mapGhRepos,
  parseBacklog,
  parseCapacityLine,
  parseCrewStateLine,
  parseGateStatus,
  parseLastRun,
  parseMetaFile,
  parseProjectRegistry,
  parseRunsTable,
  unavailable,
} from "../data.mjs";

test("parseProjectRegistry reads the local registration line", () => {
  const markdown = [
    "# Projects",
    "",
    "- factory [no-mistakes-prod-only] - Factory Console: web control plane over a Firstmate software factory (fleet, crew sessions, projects, review gate); local development copy derived from the VM implementation at usman-shamim/factory-ui (added 2026-11-18)",
  ].join("\n");

  assert.deepEqual(parseProjectRegistry(markdown), [
    {
      name: "factory",
      mode: "no-mistakes-prod-only",
      yolo: false,
      description:
        "Factory Console: web control plane over a Firstmate software factory (fleet, crew sessions, projects, review gate); local development copy derived from the VM implementation at usman-shamim/factory-ui",
      repo: null,
    },
  ]);
});

test("parseProjectRegistry honours bracket tokens in any order", () => {
  const markdown = [
    "- plantmind-copilot [no-mistakes +yolo] - AI reliability copilot for process plants (added 2026-11-09)",
    "- third-party [direct-PR branch=fix/ forge=forgejo pr=manual] - upstream fix (since 2026-11-01)",
    "- legacy-project - no bracket, defaults to no-mistakes (added 2026-10-01)",
    "- spaced name - names may contain spaces (added 2026-10-02)",
    "- registered-with-repo [no-mistakes] - plain description (repo: usman-shamim/example) (added 2026-10-03)",
  ].join("\n");

  const projects = parseProjectRegistry(markdown);
  assert.equal(projects.length, 5);

  assert.deepEqual(
    { name: projects[0].name, mode: projects[0].mode, yolo: projects[0].yolo },
    { name: "plantmind-copilot", mode: "no-mistakes", yolo: true },
  );
  assert.deepEqual(
    { name: projects[1].name, mode: projects[1].mode, yolo: projects[1].yolo },
    { name: "third-party", mode: "direct-PR", yolo: false },
    "branch= / forge= / pr= tokens are not the mode",
  );
  assert.equal(projects[2].mode, "no-mistakes", "an entry without brackets keeps the legacy default");
  assert.equal(projects[3].name, "spaced name");
  assert.equal(projects[4].description, "plain description", "a repo annotation is not part of the description");
  assert.equal(projects[4].repo, "usman-shamim/example");
});

test("parseProjectRegistry ignores prose and blank lines", () => {
  assert.deepEqual(parseProjectRegistry("# Projects\n\nNothing here yet.\n"), []);
  assert.deepEqual(parseProjectRegistry(null), []);
});

test("parseCapacityLine reads the real no-target summary", () => {
  const text =
    "capacity: free_lanes=unknown reason=no-target lanes=1 target=none secondmates=0 load1=1.21 cores=4 mem_free_pct=58 disk_free_mb=63514\n" +
    "Lanes: 1 running, no target set (config/lane-capacity absent).\n";
  assert.deepEqual(parseCapacityLine(text), {
    freeLanes: null,
    lanes: 1,
    target: null,
    reason: "no-target",
  });
});

test("parseCapacityLine anchors keys so lanes= cannot match inside free_lanes=", () => {
  const text = "capacity: free_lanes=2 reason=ok lanes=0 target=2 secondmates=0\n";
  assert.deepEqual(parseCapacityLine(text), { freeLanes: 2, lanes: 0, target: 2, reason: "ok" });

  const onlyFree = parseCapacityLine("capacity: free_lanes=1 reason=ok\n");
  assert.equal(onlyFree.lanes, null, "a missing lanes= is unknown, not 0");
});

test("parseBacklog reads the real blocked-by annotation and keeps it out of the title", () => {
  const markdown = [
    "# Backlog",
    "",
    "## In flight",
    "- [ ] factory-local-bridge - Stand up the factory console locally: bridge + dev harness (repo: factory) (kind: ship) (since 2026-11-18)",
    "  Body line that must not become a record.",
    "## Queued",
    "- [ ] factory-design-stitch - Migrate the factory console UI to the stitch design pack blocked-by: factory-local-bridge (repo: factory) (kind: ship) (since 2026-11-18)",
    "## Done",
    "- [x] old-task - Retired work (repo: factory) (kind: scout) https://github.com/usman-shamim/factory-ui/pull/11",
  ].join("\n");

  const records = parseBacklog(markdown);
  assert.equal(records.length, 3);
  assert.deepEqual(records[0], {
    id: "factory-local-bridge",
    title: "Stand up the factory console locally: bridge + dev harness",
    repo: "factory",
    state: "in_flight",
    checked: false,
    blocked: null,
    since: "2026-11-18",
    pr: null,
  });
  assert.equal(records[1].state, "queued");
  assert.equal(
    records[1].title,
    "Migrate the factory console UI to the stitch design pack",
    "the inline blocked-by annotation is not part of the title",
  );
  assert.equal(records[1].blocked, "factory-local-bridge");
  assert.equal(records[2].state, "done");
  assert.equal(records[2].checked, true);
  assert.equal(records[2].pr, "https://github.com/usman-shamim/factory-ui/pull/11");
});

test("parseBacklog drops a blocked-by reason from the title and keeps the blocker", () => {
  const markdown = [
    "## Queued",
    "- [ ] second-task - Waits on the bridge blocked-by: factory-local-bridge - needs the live endpoints (repo: factory) (since 2026-11-18)",
  ].join("\n");

  const [record] = parseBacklog(markdown);
  assert.equal(record.title, "Waits on the bridge");
  assert.equal(record.blocked, "factory-local-bridge");
});

test("parseMetaFile reads the task meta record", () => {
  const meta = parseMetaFile("kind=ship\nmode=no-mistakes\nbranch=fm/factory-local-bridge\n# comment\n\nharness=pi\n");
  assert.deepEqual(meta, { kind: "ship", mode: "no-mistakes", branch: "fm/factory-local-bridge", harness: "pi" });
});

test("parseCrewStateLine reads the authoritative state line", () => {
  assert.deepEqual(parseCrewStateLine("state: working · source: pane · harness busy (pi-ext)\n"), {
    state: "working",
    source: "pane",
    detail: "harness busy (pi-ext)",
  });
  assert.deepEqual(parseCrewStateLine("state: blocked"), { state: "blocked", source: null, detail: "" });
  assert.equal(parseCrewStateLine(""), null);
});

test("parseGateStatus matches the uninitialised string, not the exit code", () => {
  const text = "repo not initialized (run 'no-mistakes init' first)\n";
  assert.deepEqual(parseGateStatus(text), { initialised: false, daemon: null, activeRun: null });
});

test("parseGateStatus reads an initialised gate with an idle daemon", () => {
  const text = [
    "    repo:  /mnt/main/Projects/VM-agent/firstmate/projects/factory",
    "  remote:  https://github.com/usman-shamim/factory-ui.git",
    "    gate:  /home/usman/.no-mistakes/repos/6c01e655b444.git",
    "  daemon:  ● running",
    "",
    "  no active run",
  ].join("\n");

  assert.deepEqual(parseGateStatus(text), { initialised: true, daemon: "● running", activeRun: null });
});

test("parseGateStatus reports an active run label when one is printed", () => {
  const text = ["  daemon:  ● running", "", "  active run", "    branch: fm/example", "    status: running"].join("\n");
  assert.deepEqual(parseGateStatus(text), { initialised: true, daemon: "● running", activeRun: "branch: fm/example" });
});

test("parseRunsTable reads the axi TOON table and its quoted empty PR", () => {
  const text = [
    "current_branch: main",
    "runs_on_current_branch: 0",
    "count: 2 of 2 total",
    "runs[2]{id,branch,status,head,pr}:",
    '  "01M7CCGNNSBYX3THWM0ABDP3N5",fm/pmc-4-rules,cancelled,0b53b165,""',
    '  "01M70MTY424YSWP91A6MG10T35",fm/pmc-3-csv-import,ci_monitor_interrupted,f8253a82,"https://github.com/usman-shamim/plantmind-copilot/pull/10"',
    'help[2]: "Run no-mistakes axi run",No run exists for this branch',
  ].join("\n");

  const rows = parseRunsTable(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], {
    id: "01M7CCGNNSBYX3THWM0ABDP3N5",
    branch: "fm/pmc-4-rules",
    status: "cancelled",
    head: "0b53b165",
    pr: null,
  });
  assert.equal(rows[1].pr, "https://github.com/usman-shamim/plantmind-copilot/pull/10");
});

test("parseRunsTable returns nothing for an empty repository", () => {
  const text = [
    "current_branch: main",
    "runs_on_current_branch: 0",
    "runs: 0 runs yet in this repository",
  ].join("\n");
  assert.deepEqual(parseRunsTable(text), []);
});

test("parseLastRun reads the newest row of `no-mistakes runs`", () => {
  const text = [
    "  cancelled    fm/pmc-4-rules       0b53b165  2026-11-14 11:39",
    "  failed       fm/pmc-4-rules       0b53b165  2026-11-14 11:02",
    "",
    "  (3 more runs, use --limit to see more)",
  ].join("\n");

  assert.deepEqual(parseLastRun(text), {
    state: "cancelled",
    branch: "fm/pmc-4-rules",
    commit: "0b53b165",
    when: "2026-11-14 11:39",
  });
});

test("parseLastRun is null when the gate has no runs", () => {
  const text = [
    "  no runs yet. Push through the gate to start a pipeline:",
    "  git push no-mistakes <branch>",
  ].join("\n");
  assert.equal(parseLastRun(text), null);
});

test("mapGhRepos accepts both list and search field spellings", () => {
  const mine = mapGhRepos("mine", [
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
  ]);
  assert.deepEqual(mine.repos[0], {
    fullName: "usman-shamim/factory-ui",
    name: "factory-ui",
    private: false,
    description: "Web console",
    language: "TypeScript",
    updatedAt: "2026-11-16T14:39:24Z",
    stars: 0,
    url: "https://github.com/usman-shamim/factory-ui",
  });

  const discover = mapGhRepos("discover", [
    {
      fullName: "kenan805/AbstractFactoryConsole",
      name: "AbstractFactoryConsole",
      isPrivate: false,
      description: "",
      language: "C#",
      updatedAt: "2024-08-18T18:41:24Z",
      stargazersCount: 5,
      url: "https://github.com/kenan805/AbstractFactoryConsole",
    },
  ]);
  assert.equal(discover.repos[0].language, "C#");
  assert.equal(discover.repos[0].stars, 5);
});

test("mapGhRepos returns the honest empty list", () => {
  assert.deepEqual(mapGhRepos("mine", null), { scope: "mine", repos: [] });
});

test("catalogModels maps display.group and display.description", () => {
  const catalogue = {
    body: {
      data: [
        { id: "deepseek/deepseek-v4-pro", display: { group: "Open Source", description: "hybrid-attention long-context reasoning" } },
      ],
    },
  };
  assert.deepEqual(catalogModels(catalogue), [
    { id: "deepseek/deepseek-v4-pro", group: "Open Source", note: "hybrid-attention long-context reasoning" },
  ]);
  assert.deepEqual(catalogModels(null), []);
});

test("unavailable names the endpoint and the reason", () => {
  const body = unavailable("POST /api/projects", "creating a GitHub repository is a write to the account");
  assert.equal(body.error, "POST /api/projects is not available in the local build");
  assert.equal(body.reason, "creating a GitHub repository is a write to the account");
  assert.equal(body.endpoint, "POST /api/projects");
  assert.equal(body.local, true);
});
