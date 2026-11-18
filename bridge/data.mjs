/**
 * Pure derivations: Firstmate home facts -> the bridge's documented JSON shapes.
 *
 * No I/O lives here. `sources.mjs` reads files and shells out; this module only
 * parses and reshapes, so every contract can be tested against a recorded sample
 * without a fleet, a daemon, or a network.
 *
 * Shapes are the ones recorded in `factory-handoff-2026-11-16.md` §3 "Bridge API
 * - verified shapes". Where the handoff records no shape (`/healthz`) the
 * smallest honest object is used and the divergence is documented in DEPLOY.md.
 */

/** Why every write endpoint is closed in this build. */
export const LOCAL_READ_ONLY_REASON =
  "the local build reads the Firstmate home and never mutates the fleet or a repository";

/** Why the event stream is closed in this build. */
export const LOCAL_NO_STREAM_REASON =
  "the local build serves read-only JSON; the live event stream is not wired yet";

/**
 * The 501 body shared by every unwired endpoint. The endpoint list itself lives
 * in `server.mjs` (WRITE_ENDPOINTS) and in DEPLOY.md, so the next task can fill
 * the handlers in without hunting for them.
 */
export function unavailable(endpoint, reason = LOCAL_READ_ONLY_REASON) {
  return {
    error: `${endpoint} is not available in the local build`,
    reason,
    endpoint,
    local: true,
  };
}

/**
 * Parse `data/projects.md`. The registry format is owned by
 * `bin/fm-project-mode.sh`; this mirrors its documented rules:
 *
 *   - <name> - <desc> (added <date>)
 *   - <name> [<mode> +yolo branch=<prefix> forge=<forge> pr=<pr>] - <desc> (added <date>)
 *
 * The name ends at the first " [" or " - " that follows it. Bracket tokens are
 * order independent: `+yolo`, `branch=`, `forge=` and `pr=` are recognised by
 * shape, and the first token left over is the mode.
 */
export function parseProjectRegistry(markdown) {
  const projects = [];
  for (const rawLine of String(markdown ?? "").split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.startsWith("- ")) continue;

    let nameEnd = line.length;
    for (const sep of [" [", " - "]) {
      const at = line.indexOf(sep, 2);
      if (at !== -1 && at < nameEnd) nameEnd = at;
    }
    const name = line.slice(2, nameEnd).trim();
    if (!name) continue;

    let rest = line.slice(nameEnd);
    let mode = "no-mistakes";
    let yolo = false;

    if (rest.startsWith(" [")) {
      const close = rest.indexOf("]");
      const bracket = close === -1 ? rest.slice(2) : rest.slice(2, close);
      const after = close === -1 ? "" : rest.slice(close + 1);
      let modeSet = false;
      for (const token of bracket.split(/\s+/).filter(Boolean)) {
        if (token === "+yolo") {
          yolo = true;
          continue;
        }
        if (token.startsWith("branch=") || token.startsWith("forge=") || token.startsWith("pr=")) continue;
        if (modeSet) continue;
        mode = token;
        modeSet = true;
      }
      rest = after;
    }

    let description = "";
    const dash = rest.indexOf(" - ");
    if (dash !== -1) description = rest.slice(dash + 3);
    description = description
      .replace(/\s*\((?:added|since)\s+\d{4}-\d{2}-\d{2}\)\s*$/i, "")
      .trim();

    let repo = null;
    const repoInText = description.match(/\(repo:\s*([\w.-]+\/[\w.-]+)\)/i);
    if (repoInText) {
      repo = repoInText[1];
      description = description.replace(repoInText[0], "").trim();
    }

    projects.push({ name, mode, yolo, description, repo });
  }
  return projects;
}

/**
 * Parse the one-line summary `bin/fm-capacity.sh` prints:
 *
 *   capacity: free_lanes=unknown reason=no-target lanes=1 target=none ...
 *
 * Keys are anchored on `(?:^|\s)` so `lanes=` cannot match inside `free_lanes=`
 * (a trap already paid for in the handoff). Unknown or absent numbers are null,
 * never 0: 0 free lanes and "we cannot know" are different claims.
 */
export function parseCapacityLine(text) {
  const output = String(text ?? "");
  const line = output.split("\n").find((l) => l.trimStart().startsWith("capacity:")) ?? output;

  const field = (key) => {
    const match = line.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`));
    return match ? match[1] : null;
  };
  const count = (key) => {
    const value = field(key);
    if (value === null) return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) ? null : parsed;
  };

  return {
    freeLanes: count("free_lanes"),
    lanes: count("lanes"),
    target: count("target"),
    reason: field("reason"),
  };
}

/**
 * Parse `data/backlog.md` as a fallback for the fleet snapshot. Entries are
 * `- [ ] <id> - <title> blocked-by: <id> [- <reason>] (repo: <repo>)
 * (kind: <kind>) (since <date>)`, grouped under `## In flight`, `## Queued` and
 * `## Done`.
 *
 * `blocked-by:` is an inline annotation in the title text, not a parenthesised
 * field, so it is stripped from the title and read as the blocker, the same
 * derivation `title_of`/`blocked_by` applies in `bin/fm-fleet-snapshot.sh`.
 */
export function parseBacklog(markdown) {
  const records = [];
  let state = "unknown";
  for (const rawLine of String(markdown ?? "").split("\n")) {
    const line = rawLine.trimEnd();
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      const label = heading[1].toLowerCase();
      if (label.startsWith("in flight") || label.startsWith("in-flight")) state = "in_flight";
      else if (label.startsWith("queued")) state = "queued";
      else if (label.startsWith("done")) state = "done";
      else state = label.replace(/\s+/g, "_");
      continue;
    }
    const entry = line.match(/^-\s+\[([ xX])\]\s+(\S+)\s+-\s+(.*)$/);
    if (!entry) continue;

    const [, checked, id, body] = entry;
    const fieldOf = (key) => {
      const match = body.match(new RegExp(`\\(${key}\\s*:?\\s*([^)]*)\\)`, "i"));
      return match ? match[1].trim() : null;
    };
    const prMatch = body.match(/https?:\/\/\S+?\/pull\/\d+/);
    const blockedBy = [...body.matchAll(/blocked-by:\s*([^\s)]+)/gi)].map((match) => match[1]);
    records.push({
      id,
      title: body
        .split(/\s+\(/)[0]
        .replace(/\s*blocked-by:\s*[^\s)]+\s+-\s+.*$/i, "")
        .replace(/\s*blocked-by:\s*[^\s)]+/gi, "")
        .trim(),
      repo: fieldOf("repo"),
      state,
      checked: checked.toLowerCase() === "x",
      blocked: blockedBy.length ? [...new Set(blockedBy)].join(",") : null,
      since: fieldOf("since"),
      pr: prMatch ? prMatch[0] : null,
    });
  }
  return records;
}

/** Parse `state/<id>.meta`, a flat `key=value` record. */
export function parseMetaFile(text) {
  const meta = {};
  for (const rawLine of String(text ?? "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at === -1) continue;
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return meta;
}

/**
 * Parse the single line `bin/fm-crew-state.sh <id>` prints:
 *
 *   state: working · source: pane · harness busy (pi-ext)
 *
 * It is the authoritative current state, so it beats a stale status-log tail.
 */
export function parseCrewStateLine(text) {
  const line = String(text ?? "").trim();
  if (!line) return null;
  const match = line.match(/^state:\s*([a-z_-]+)\s*·\s*source:\s*([a-z_-]+)\s*·\s*(.*)$/i);
  if (match) return { state: match[1].toLowerCase(), source: match[2].toLowerCase(), detail: match[3] };
  const stateOnly = line.match(/^state:\s*([a-z_-]+)/i);
  return stateOnly ? { state: stateOnly[1].toLowerCase(), source: null, detail: "" } : null;
}

/**
 * Parse the text from `no-mistakes status` in one project clone.
 *
 * Initialised output: `repo:`, `remote:`, `gate:`, `daemon:  ● running`, then
 * either `no active run` or an active-run block. Uninitialised output is the
 * one line `repo not initialized (run 'no-mistakes init' first)` and still exits
 * 0, which is the trap the handoff names: match the string, never the exit code.
 *
 * The active-run block is capitalised and puts the run id first:
 *
 *     Active run
 *          id:  01M7PXQPKNFFEX501311KHVZED
 *      branch:  fm/example
 *
 */
export function parseGateStatus(text) {
  const output = String(text ?? "");
  const result = { initialised: false, daemon: null, activeRun: null };
  if (!output.trim()) return result;
  if (/not initiali[sz]ed/i.test(output)) return result;

  result.initialised = true;
  const daemon = output.match(/^\s*daemon:\s*(.+)$/m);
  if (daemon) result.daemon = daemon[1].trim();

  const afterDaemon = output.split(/^\s*daemon:.*$/m).slice(1).join("\n");
  if (/no active run/i.test(afterDaemon)) return result;

  const activeHeader = afterDaemon.match(/^\s*active run\b[^\n]*$/im);
  if (activeHeader) {
    const tail = afterDaemon.slice(afterDaemon.indexOf(activeHeader[0]) + activeHeader[0].length);
    const first = tail.split("\n").map((line) => line.trim()).find(Boolean);
    result.activeRun = first ? first.replace(/^[a-z]+:\s*/i, "") : null;
  }
  return result;
}

/** Split one TOON table row, honouring quoted cells. */
function splitTableRow(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else quoted = false;
      } else current += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      cells.push(current);
      current = "";
    } else current += ch;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

/**
 * Parse the run table from `no-mistakes axi status`:
 *
 *   runs[2]{id,branch,status,head,pr}:
 *     "01M7...",fm/pmc-4-rules,cancelled,0b53b165,""
 *
 * Newest first, which is how the last run's PR is recovered. Fields beyond the
 * documented header are ignored rather than guessed at.
 */
export function parseRunsTable(text) {
  const lines = String(text ?? "").split("\n");
  const headerAt = lines.findIndex((line) => /^\s*runs\[\d+\]\{([^}]*)\}:\s*$/.test(line));
  if (headerAt === -1) return [];
  const header = lines[headerAt].match(/\{([^}]*)\}/)[1].split(",").map((cell) => cell.trim());
  const rows = [];
  for (const line of lines.slice(headerAt + 1)) {
    if (!line.trim()) break;
    if (!/^\s/.test(line)) break;
    const cells = splitTableRow(line);
    if (cells.length !== header.length) continue;
    const row = {};
    header.forEach((key, index) => {
      row[key] = cells[index] || null;
    });
    rows.push(row);
  }
  return rows;
}

/**
 * Parse the first row of `no-mistakes runs --limit 1`:
 *
 *     cancelled    fm/pmc-4-rules       0b53b165  2026-11-14 11:39
 *
 * `no runs yet` prints prose instead, so an empty gate has no last run.
 */
export function parseLastRun(text) {
  for (const line of String(text ?? "").split("\n")) {
    const match = line.match(/^\s*(\S+)\s+(\S+)\s+([0-9a-f]{6,40})\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*$/i);
    if (match) return { state: match[1], branch: match[2], commit: match[3], when: match[4] };
  }
  return null;
}

/**
 * Map `gh` JSON rows onto the documented repository shape. `gh repo list` and
 * `gh search repos` disagree on two field names (`primaryLanguage` vs
 * `language`, `stargazerCount` vs `stargazersCount`), so both are accepted here
 * instead of branching at the call site.
 */
export function mapGhRepos(scope, rows) {
  return {
    scope,
    repos: (Array.isArray(rows) ? rows : []).map((row) => ({
      fullName: row.fullName ?? row.nameWithOwner ?? null,
      name: row.name ?? null,
      private: Boolean(row.isPrivate),
      description: row.description ?? "",
      language: row.language ?? row.primaryLanguage?.name ?? null,
      updatedAt: row.updatedAt ?? null,
      stars: row.stargazersCount ?? row.stargazerCount ?? 0,
      url: row.url ?? null,
    })),
  };
}

/**
 * Map the command-code model catalogue onto `{id, group, note}`:
 * `display.group` is the group and `display.description` the note, which is the
 * pairing the handoff records.
 */
export function catalogModels(catalog) {
  const body = catalog?.body ?? catalog;
  const data = Array.isArray(body?.data) ? body.data : [];
  return data.map((model) => ({
    id: model.id,
    group: model.display?.group ?? "Ungrouped",
    note: model.display?.description ?? "",
  }));
}
