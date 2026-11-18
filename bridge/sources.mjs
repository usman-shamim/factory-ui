/**
 * Real data sources for the local bridge: files in the Firstmate home, the
 * fleet's own `bin/` helpers, the local `gh` CLI and the local agent config.
 *
 * Every reader degrades to an honest empty value instead of throwing: a project
 * without a clone is `not initialised`, a host without a model catalogue has no
 * models, an unauthenticated `gh` returns no repositories plus the reason. The
 * server never invents a fact to fill a shape.
 *
 * Nothing here writes. There is no token path, no SSO, no HMAC and no CORS.
 */
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  catalogModels,
  parseBacklog,
  parseCapacityLine,
  parseCrewStateLine,
  parseGateStatus,
  parseLastRun,
  parseMetaFile,
  parseProjectRegistry,
  parseRunsTable,
  mapGhRepos,
} from "./data.mjs";

/** The Firstmate home this build reads. Defaults to the one on this machine. */
export const DEFAULT_FM_HOME = "/mnt/main/Projects/VM-agent/firstmate";

const GH_MINE_FIELDS =
  "name,nameWithOwner,isPrivate,description,primaryLanguage,updatedAt,stargazerCount,url";
const GH_DISCOVER_FIELDS =
  "fullName,name,isPrivate,description,language,updatedAt,stargazersCount,url";

/**
 * Run a command and resolve; never reject. `ok` is the only success flag, so a
 * missing binary and a non-zero exit are handled the same honest way.
 */
function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout ?? 15_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env },
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          error: error ? String(error.message ?? error) : null,
        });
      },
    );
  });
}

async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function readJson(file) {
  const text = await readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function listDir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function isDirectory(target) {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** `owner/name` from any of the clone's origin URL spellings, or null. */
function repoFromRemoteUrl(url) {
  const match = String(url ?? "").match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?\s*$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** `plantmind-copilot` from a project path; the registry name is the last segment. */
function baseName(target) {
  if (!target) return null;
  return path.basename(String(target).replace(/[\\/]+$/, ""));
}

function firstLine(text) {
  return String(text ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

/**
 * Build the source set the server depends on. Every method is async and every
 * method is replaceable, which is how the tests pin shapes without a fleet.
 */
export function createSources({
  fmHome = process.env.FM_HOME || DEFAULT_FM_HOME,
  home = os.homedir(),
  run = runCommand,
} = {}) {
  const source = {
    fmHome,
    home,

    /** POST or GET /api/session. Local mode has no edge and no secret. */
    async session() {
      const gitEmail = await run("git", ["config", "--get", "user.email"], { cwd: fmHome, timeout: 5_000 });
      return {
        token: `local-${randomUUID()}`,
        email: gitEmail.ok && gitEmail.stdout.trim() ? gitEmail.stdout.trim() : "local@localhost",
        via: "local",
        expiresIn: 900,
      };
    },

    /** data/projects.md, with each clone's origin as the resolved repo. */
    async projects() {
      const registry = await readText(path.join(fmHome, "data", "projects.md"));
      const projects = parseProjectRegistry(registry);
      for (const project of projects) {
        if (project.repo) continue;
        const clone = await resolveProjectDir(project.name);
        if (!clone) continue;
        const remote = await run("git", ["remote", "get-url", "origin"], { cwd: clone, timeout: 5_000 });
        project.repo = remote.ok ? repoFromRemoteUrl(remote.stdout) : null;
      }
      return projects.map((project) => ({
        name: project.name,
        mode: project.mode,
        yolo: project.yolo,
        description: project.description,
        repo: project.repo ?? null,
      }));
    },

    /** `bin/fm-capacity.sh`; a missing helper is unknown capacity, never zero. */
    async capacity() {
      const result = await run("bash", [path.join(fmHome, "bin", "fm-capacity.sh")], {
        cwd: fmHome,
        timeout: 30_000,
      });
      if (!result.ok && !result.stdout.trim()) {
        return {
          freeLanes: null,
          lanes: null,
          target: null,
          reason: firstLine(result.stderr) || "capacity unavailable",
        };
      }
      return parseCapacityLine(result.stdout);
    },

    /** `bin/fm-fleet-snapshot.sh --json`, the authoritative fleet reading. */
    async snapshot() {
      const result = await run("bash", [path.join(fmHome, "bin", "fm-fleet-snapshot.sh"), "--json"], {
        cwd: fmHome,
        timeout: 90_000,
      });
      if (!result.ok || !result.stdout.trim()) return null;
      try {
        return JSON.parse(result.stdout);
      } catch {
        return null;
      }
    },

    /** `bin/fm-crew-state.sh <id>`: authoritative current state for one crew. */
    async crewState(id) {
      const result = await run("bash", [path.join(fmHome, "bin", "fm-crew-state.sh"), id], {
        cwd: fmHome,
        timeout: 20_000,
      });
      if (!result.ok && !result.stdout.trim()) return null;
      return parseCrewStateLine(result.stdout);
    },

    /** Lanes for one home, from the snapshot with `state/*.meta` as the fallback. */
    async lanes(snapshot = null) {
      const tasks = normalizedTasks(snapshot);
      if (tasks.length) {
        return Promise.all(
          tasks.map(async (task) => {
            let state = task.state;
            if (!state || state === "unknown") {
              const crew = await source.crewState(task.id);
              state = crew?.state ?? "unknown";
            }
            return { ...task, state };
          }),
        );
      }
      const metaRecords = await metaTasks();
      return Promise.all(
        metaRecords.map(async (task) => {
          const crew = await source.crewState(task.id);
          return { ...task, state: crew?.state ?? "unknown" };
        }),
      );
    },

    /** GET /api/crews: capacity, the primary home, any readable secondmate, queued work. */
    async crews() {
      const [capacity, snapshot] = await Promise.all([source.capacity(), source.snapshot()]);
      const primaryTasks = await source.lanes(snapshot);
      const crews = [
        {
          id: baseName(fmHome) || "firstmate",
          home: fmHome,
          kind: "primary",
          scope: null,
          lanes: primaryTasks.map(laneOf),
        },
      ];

      const secondmates = Array.isArray(snapshot?.secondmate_current?.records)
        ? snapshot.secondmate_current.records
        : [];
      for (const record of secondmates) {
        const secondHome = typeof record?.home === "string" && record.home.startsWith("/") ? record.home : null;
        if (!secondHome || !(await isDirectory(secondHome))) continue;
        const secondSnapshot = await run(
          "bash",
          [path.join(secondHome, "bin", "fm-fleet-snapshot.sh"), "--json"],
          { cwd: secondHome, timeout: 90_000 },
        );
        let tasks = [];
        if (secondSnapshot.ok) {
          try {
            tasks = normalizedTasks(JSON.parse(secondSnapshot.stdout));
          } catch {
            tasks = [];
          }
        }
        crews.push({
          id: record.id ?? baseName(secondHome) ?? secondHome,
          home: secondHome,
          kind: "secondmate",
          scope: record.scope ?? record.charter ?? null,
          lanes: tasks.map(laneOf),
        });
      }

      return {
        capacity,
        crews,
        queued: await queuedWork(snapshot),
      };
    },

    /** GET /api/gate: one row per registered project. */
    async gate() {
      const projects = parseProjectRegistry(await readText(path.join(fmHome, "data", "projects.md")));
      const rows = [];
      for (const project of projects) {
        const dir = await resolveProjectDir(project.name);
        if (!dir) {
          rows.push(notInitialised(project.name));
          continue;
        }

        const status = await run("no-mistakes", ["status"], { cwd: dir, timeout: 20_000 });
        const statusText = status.stdout || status.stderr;
        if (!status.ok && !/not initiali[sz]ed/i.test(statusText)) {
          rows.push({
            ...notInitialised(project.name),
            error: firstLine(statusText) || status.error || "no-mistakes status failed",
          });
          continue;
        }

        const parsed = parseGateStatus(statusText);
        if (!parsed.initialised) {
          rows.push(notInitialised(project.name));
          continue;
        }

        const runs = await run("no-mistakes", ["runs", "--limit", "1"], { cwd: dir, timeout: 20_000 });
        const lastRun = runs.ok ? parseLastRun(runs.stdout) : null;
        let pr = null;
        if (lastRun) {
          // `runs` records state, branch, commit and time but not the PR, and
          // `axi status` records the PR but not the time: read both, take the
          // newest row of the table for the PR of the newest run.
          const axi = await run("no-mistakes", ["axi", "status"], { cwd: dir, timeout: 20_000 });
          if (axi.ok) pr = parseRunsTable(axi.stdout)[0]?.pr || null;
        }

        rows.push({
          project: project.name,
          initialised: true,
          daemon: parsed.daemon,
          activeRun: parsed.activeRun,
          lastRun: lastRun ? { ...lastRun, pr } : null,
        });
      }
      return { projects: rows };
    },

    /** GET /api/setup: harness, default model, catalogue, connectors, skills. */
    async setup() {
      const [harness, defaultModel, models, mcp, skills] = await Promise.all([
        detectHarness(),
        detectDefaultModel(),
        detectModels(),
        detectMcp(),
        detectSkills(),
      ]);
      return {
        harness,
        defaultModel,
        models,
        mcp,
        skills,
        counts: { models: models.length, mcp: mcp.length, skills: skills.length },
      };
    },

    /** GET /api/rooms: the task's tmux/herdr window, branch, PR and current state. */
    async rooms() {
      const snapshot = await source.snapshot();
      const tasks = await source.lanes(snapshot);
      return {
        rooms: tasks.map((task) => ({
          id: task.id,
          task: task.title ?? task.id,
          window: task.window,
          branch: task.branch,
          pr: task.pr,
          status: task.state,
        })),
      };
    },

    /** GET /api/github/repos?scope=mine|discover&q=, read through the `gh` CLI. */
    async repos(scope, q = "") {
      const query = String(q ?? "").trim();
      if (scope === "mine") {
        const result = await run("gh", ["repo", "list", "--limit", "100", "--json", GH_MINE_FIELDS], {
          timeout: 45_000,
        });
        if (!result.ok) return ghFailure("mine", result);
        let rows = [];
        try {
          rows = JSON.parse(result.stdout);
        } catch {
          return ghFailure("mine", { error: "gh returned unparseable JSON" });
        }
        if (query) {
          const needle = query.toLowerCase();
          rows = rows.filter(
            (row) =>
              String(row.name ?? "").toLowerCase().includes(needle) ||
              String(row.description ?? "").toLowerCase().includes(needle),
          );
        }
        return mapGhRepos("mine", rows);
      }

      const args = ["search", "repos"];
      if (query) args.push(query);
      args.push("--limit", "30", "--json", GH_DISCOVER_FIELDS);
      const result = await run("gh", args, { timeout: 45_000 });
      if (!result.ok) return ghFailure("discover", result);
      try {
        return mapGhRepos("discover", JSON.parse(result.stdout));
      } catch {
        return ghFailure("discover", { error: "gh returned unparseable JSON" });
      }
    },
  };

  /** A project clone is either under the home's projects/ or directly under $HOME. */
  async function resolveProjectDir(name) {
    for (const candidate of [path.join(fmHome, "projects", name), path.join(home, name)]) {
      if (await isDirectory(candidate)) return candidate;
    }
    return null;
  }

  /** Fallback lane records from `state/*.meta` when the snapshot is unavailable. */
  async function metaTasks() {
    const entries = await listDir(path.join(fmHome, "state"));
    const records = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".meta")) continue;
      const meta = parseMetaFile(await readText(path.join(fmHome, "state", entry.name)));
      const id = entry.name.slice(0, -".meta".length);
      records.push({
        id,
        project: baseName(meta.project),
        state: "unknown",
        branch: meta.branch || null,
        pr: null,
        window: meta.window || `fm-${id}`,
        title: meta.endpoint_task_id || id,
      });
    }
    return records;
  }

  /** Queued work from the snapshot, then from `data/backlog.md`. */
  async function queuedWork(snapshot) {
    const records = Array.isArray(snapshot?.backlog?.records) ? snapshot.backlog.records : null;
    if (records) {
      return records
        .filter((record) => record?.state === "queued")
        .map((record) => ({
          id: record.id,
          title: record.title ?? record.id,
          repo: record.repo ?? null,
          state: record.state ?? "queued",
          blocked: record.blocked_reason ?? record.blocked_by ?? null,
          since: record.since ?? null,
          pr: record.pr_url ?? null,
        }));
    }
    const fallback = parseBacklog(await readText(path.join(fmHome, "data", "backlog.md")));
    return fallback
      .filter((record) => record.state === "queued")
      .map((record) => ({
        id: record.id,
        title: record.title,
        repo: record.repo,
        state: record.state,
        blocked: record.blocked,
        since: record.since,
        pr: record.pr,
      }));
  }

  /** Harness the fleet was launched with, from the per-task meta records. */
  async function detectHarness() {
    const entries = await listDir(path.join(fmHome, "state"));
    const counts = new Map();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".meta")) continue;
      const meta = parseMetaFile(await readText(path.join(fmHome, "state", entry.name)));
      if (!meta.harness) continue;
      counts.set(meta.harness, (counts.get(meta.harness) ?? 0) + 1);
    }
    let best = "unknown";
    let bestCount = 0;
    for (const [harness, count] of counts) {
      if (count > bestCount) {
        best = harness;
        bestCount = count;
      }
    }
    return best;
  }

  /** Default model of the local agent harness that is actually configured. */
  async function detectDefaultModel() {
    const piSettings = await readJson(path.join(home, ".pi", "agent", "settings.json"));
    if (typeof piSettings?.defaultModel === "string" && piSettings.defaultModel) return piSettings.defaultModel;
    const commandCode = await readJson(path.join(home, ".commandcode", "config.json"));
    if (typeof commandCode?.model === "string" && commandCode.model) return commandCode.model;
    return null;
  }

  /** Newest command-code model catalogue, mapped to {id, group, note}. */
  async function detectModels() {
    const dir = path.join(home, ".commandcode", "cache", "model-catalog", "v1");
    const entries = (await listDir(dir)).filter(
      (entry) => entry.isFile() && entry.name.startsWith("catalog-") && entry.name.endsWith(".json"),
    );
    if (!entries.length) return [];
    const catalogues = [];
    for (const entry of entries) {
      const catalogue = await readJson(path.join(dir, entry.name));
      if (catalogue) catalogues.push(catalogue);
    }
    if (!catalogues.length) return [];
    catalogues.sort((a, b) => Number(b?.fetchedAt ?? 0) - Number(a?.fetchedAt ?? 0));
    return catalogModels(catalogues[0]);
  }

  /** MCP servers configured for the local harnesses (pi first, then command-code). */
  async function detectMcp() {
    const servers = [];
    const seen = new Set();
    for (const file of [
      path.join(home, ".pi", "agent", "mcp.json"),
      path.join(home, ".commandcode", "mcp.json"),
    ]) {
      const config = await readJson(file);
      const table = config?.mcpServers ?? config?.servers ?? {};
      for (const [name, value] of Object.entries(table)) {
        if (seen.has(name)) continue;
        seen.add(name);
        const target = value?.url
          ? value.url
          : [value?.command, ...(Array.isArray(value?.args) ? value.args : [])].filter(Boolean).join(" ");
        servers.push({ name, target: target || "" });
      }
    }
    return servers;
  }

  /** Skills installed for the local harnesses, grouped by the home they came from. */
  async function detectSkills() {
    const roots = [
      [path.join(home, ".agents", "skills"), "agents"],
      [path.join(fmHome, "skills"), "firstmate"],
      [path.join(home, ".pi", "agent", "skills"), "pi"],
      [path.join(home, ".commandcode", "skills"), "commandcode"],
    ];
    const skills = [];
    const seen = new Set();
    for (const [dir, sourceName] of roots) {
      for (const entry of await listDir(dir)) {
        if (!entry.isDirectory() || seen.has(entry.name)) continue;
        seen.add(entry.name);
        skills.push({ name: entry.name, source: sourceName });
      }
    }
    return skills;
  }

  return source;

  /** Normalise snapshot tasks to the lane record the shapes need, plus a title. */
  function normalizedTasks(snapshot) {
    if (!Array.isArray(snapshot?.tasks)) return [];
    return snapshot.tasks.map((task) => ({
      id: task.id,
      project: baseName(task.project),
      projectPath: task.project ?? null,
      state: task.current_state?.state || "unknown",
      branch: task.branch ?? null,
      pr: task.pr?.url ?? task.backlog?.pr_url ?? null,
      window: task.endpoint?.target ?? task.paths?.meta?.window ?? `fm-${task.id}`,
      title: task.backlog?.title ?? task.id,
    }));
  }
}

/** The documented lane shape (no title; that belongs to a room). */
function laneOf(task) {
  return {
    id: task.id,
    project: task.project,
    state: task.state,
    branch: task.branch,
    pr: task.pr,
    window: task.window,
  };
}

function notInitialised(project) {
  return { project, initialised: false, daemon: null, activeRun: null, lastRun: null, error: "not initialised" };
}

function ghFailure(scope, result) {
  const detail = firstLine(result?.stderr) || result?.error || "gh failed";
  return { ...mapGhRepos(scope, []), error: `github unavailable: ${detail}` };
}
