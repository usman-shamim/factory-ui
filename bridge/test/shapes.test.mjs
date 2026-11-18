/**
 * Response-shape contracts for the bridge's read endpoints, plus the 501 wall in
 * front of every write.
 *
 * The server is driven over real HTTP with injected sources, so the assertions
 * cover the documented keys, the honest empty states, and the refusal bodies
 * without touching a fleet, a daemon or the network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { createServer } from "../server.mjs";

const CAPACITY = { freeLanes: 2, lanes: 0, target: 2, reason: "ok" };

function fakeSources(overrides = {}) {
  return {
    fmHome: "/tmp/fm-home",
    session: async () => ({ token: "local-test", email: "local@localhost", via: "local", expiresIn: 900 }),
    projects: async () => [],
    crews: async () => ({
      capacity: CAPACITY,
      crews: [{ id: "firstmate", home: "/tmp/fm-home", kind: "primary", scope: null, lanes: [] }],
      queued: [],
    }),
    gate: async () => ({ projects: [] }),
    setup: async () => ({
      harness: "pi",
      defaultModel: null,
      models: [],
      mcp: [],
      skills: [],
      counts: { models: 0, mcp: 0, skills: 0 },
    }),
    rooms: async () => ({ rooms: [] }),
    repos: async (scope) => ({ scope, repos: [] }),
    ...overrides,
  };
}

async function withServer(sources, fn) {
  const server = createServer({ sources, log: () => {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`, port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function getJson(base, path, init) {
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

const keys = (object) => Object.keys(object).sort();

test("GET /healthz names the service, the local mode and the home", async () => {
  await withServer(fakeSources(), async (base) => {
    const { status, body } = await getJson(base, "/healthz");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, "factory-bridge");
    assert.equal(body.mode, "local");
    assert.equal(body.home, "/tmp/fm-home");
  });
});

test("GET and POST /api/session both return the local token shape", async () => {
  await withServer(fakeSources(), async (base) => {
    for (const method of ["GET", "POST"]) {
      const { status, body } = await getJson(base, "/api/session", { method });
      assert.equal(status, 200, `${method} /api/session`);
      assert.deepEqual(keys(body), ["email", "expiresIn", "token", "via"]);
      assert.equal(body.via, "local");
      assert.equal(typeof body.token, "string");
      assert.ok(body.token.length > 0);
      assert.equal(typeof body.expiresIn, "number");
    }
  });
});

test("GET /api/projects returns the documented project keys", async () => {
  const sources = fakeSources({
    projects: async () => [
      {
        name: "factory",
        mode: "no-mistakes-prod-only",
        yolo: false,
        description: "Factory Console",
        repo: "usman-shamim/factory-ui",
      },
    ],
  });

  await withServer(sources, async (base) => {
    const { status, body } = await getJson(base, "/api/projects");
    assert.equal(status, 200);
    assert.deepEqual(keys(body), ["projects"]);
    assert.equal(body.projects.length, 1);
    assert.deepEqual(keys(body.projects[0]), ["description", "mode", "name", "repo", "yolo"]);
  });
});

test("GET /api/projects is an honest empty list when the registry is absent", async () => {
  await withServer(fakeSources(), async (base) => {
    const { body } = await getJson(base, "/api/projects");
    assert.deepEqual(body, { projects: [] });
  });
});

test("GET /api/crews returns capacity, crews and queued with the documented keys", async () => {
  const sources = fakeSources({
    crews: async () => ({
      capacity: CAPACITY,
      crews: [
        {
          id: "firstmate",
          home: "/tmp/fm-home",
          kind: "primary",
          scope: null,
          lanes: [
            {
              id: "factory-local-bridge",
              project: "factory",
              state: "working",
              branch: "fm/factory-local-bridge",
              pr: null,
              window: "default:wA:p2",
            },
          ],
        },
        { id: "sentinel", home: "/tmp/fm-sentinel", kind: "secondmate", scope: "Sentinel content platform", lanes: [] },
      ],
      queued: [
        {
          id: "factory-design-stitch",
          title: "Migrate the UI to the stitch design pack",
          repo: "factory",
          state: "queued",
          blocked: "factory-local-bridge",
          since: "2026-11-18",
          pr: null,
        },
      ],
    }),
  });

  await withServer(sources, async (base) => {
    const { status, body } = await getJson(base, "/api/crews");
    assert.equal(status, 200);
    assert.deepEqual(keys(body), ["capacity", "crews", "queued"]);
    assert.deepEqual(keys(body.capacity), ["freeLanes", "lanes", "reason", "target"]);
    assert.deepEqual(keys(body.crews[0]), ["home", "id", "kind", "lanes", "scope"]);
    assert.deepEqual(keys(body.crews[0].lanes[0]), ["branch", "id", "pr", "project", "state", "window"]);
    assert.deepEqual(keys(body.queued[0]), ["blocked", "id", "pr", "repo", "since", "state", "title"]);
  });
});

test("GET /api/crews keeps the honest empty state when nothing is dispatched", async () => {
  const sources = fakeSources({
    crews: async () => ({
      capacity: { freeLanes: null, lanes: null, target: null, reason: "no-target" },
      crews: [{ id: "firstmate", home: "/tmp/fm-home", kind: "primary", scope: null, lanes: [] }],
      queued: [],
    }),
  });

  await withServer(sources, async (base) => {
    const { body } = await getJson(base, "/api/crews");
    assert.deepEqual(body.crews[0].lanes, []);
    assert.deepEqual(body.queued, []);
    assert.equal(body.capacity.freeLanes, null, "unknown capacity is null, never 0");
    assert.equal(body.capacity.reason, "no-target");
  });
});

test("GET /api/gate returns the handoff's not-initialised record", async () => {
  const sources = fakeSources({
    gate: async () => ({
      projects: [
        { project: "sentinal-media", initialised: false, daemon: null, activeRun: null, lastRun: null, error: "not initialised" },
      ],
    }),
  });

  await withServer(sources, async (base) => {
    const { status, body } = await getJson(base, "/api/gate");
    assert.equal(status, 200);
    assert.deepEqual(keys(body), ["projects"]);
    assert.deepEqual(body.projects[0], {
      project: "sentinal-media",
      initialised: false,
      daemon: null,
      activeRun: null,
      lastRun: null,
      error: "not initialised",
    });
  });
});

test("GET /api/gate returns the last-run shape for an initialised project", async () => {
  const sources = fakeSources({
    gate: async () => ({
      projects: [
        {
          project: "plantmind-copilot",
          initialised: true,
          daemon: "● running",
          activeRun: null,
          lastRun: {
            state: "completed",
            branch: "fm/e2e-healthcheck",
            commit: "c78fe2eb",
            when: "2026-11-15 03:59",
            pr: "https://github.com/usman-shamim/plantmind-copilot/pull/11",
          },
        },
      ],
    }),
  });

  await withServer(sources, async (base) => {
    const { body } = await getJson(base, "/api/gate");
    const row = body.projects[0];
    assert.deepEqual(keys(row), ["activeRun", "daemon", "initialised", "lastRun", "project"]);
    assert.deepEqual(keys(row.lastRun), ["branch", "commit", "pr", "state", "when"]);
  });
});

test("GET /api/gate is an honest empty list when nothing is registered", async () => {
  await withServer(fakeSources(), async (base) => {
    const { body } = await getJson(base, "/api/gate");
    assert.deepEqual(body, { projects: [] });
  });
});

test("GET /api/setup returns the documented keys and consistent counts", async () => {
  const sources = fakeSources({
    setup: async () => ({
      harness: "commandcode",
      defaultModel: "deepseek/deepseek-v4.1-flash",
      models: [{ id: "deepseek/deepseek-v4-pro", group: "Open Source", note: "hybrid-attention long-context reasoning" }],
      mcp: [{ name: "context7", target: "https://mcp.context7.com/mcp" }],
      skills: [{ name: "agent-reach", source: "agents" }],
      counts: { models: 1, mcp: 1, skills: 1 },
    }),
  });

  await withServer(sources, async (base) => {
    const { status, body } = await getJson(base, "/api/setup");
    assert.equal(status, 200);
    assert.deepEqual(keys(body), ["counts", "defaultModel", "harness", "mcp", "models", "skills"]);
    assert.deepEqual(keys(body.counts), ["mcp", "models", "skills"]);
    assert.deepEqual(keys(body.models[0]), ["group", "id", "note"]);
    assert.deepEqual(keys(body.mcp[0]), ["name", "target"]);
    assert.deepEqual(keys(body.skills[0]), ["name", "source"]);
    assert.equal(body.counts.models, body.models.length);
    assert.equal(body.counts.mcp, body.mcp.length);
    assert.equal(body.counts.skills, body.skills.length);
  });
});

test("GET /api/setup keeps the honest empty state when the host has nothing", async () => {
  await withServer(fakeSources(), async (base) => {
    const { body } = await getJson(base, "/api/setup");
    assert.deepEqual(body.models, []);
    assert.deepEqual(body.mcp, []);
    assert.deepEqual(body.skills, []);
    assert.deepEqual(body.counts, { models: 0, mcp: 0, skills: 0 });
    assert.equal(body.defaultModel, null);
  });
});

test("GET /api/rooms returns the room shape", async () => {
  const sources = fakeSources({
    rooms: async () => ({
      rooms: [
        {
          id: "factory-local-bridge",
          task: "Stand up the factory console locally",
          window: "default:wA:p2",
          branch: "fm/factory-local-bridge",
          pr: null,
          status: "working",
        },
      ],
    }),
  });

  await withServer(sources, async (base) => {
    const { status, body } = await getJson(base, "/api/rooms");
    assert.equal(status, 200);
    assert.deepEqual(keys(body), ["rooms"]);
    assert.deepEqual(keys(body.rooms[0]), ["branch", "id", "pr", "status", "task", "window"]);
  });
});

test("GET /api/github/repos defaults to mine and forwards the scope and query", async () => {
  const calls = [];
  const sources = fakeSources({
    repos: async (scope, q) => {
      calls.push({ scope, q });
      return { scope, repos: [] };
    },
  });

  await withServer(sources, async (base) => {
    const mine = await getJson(base, "/api/github/repos");
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body, { scope: "mine", repos: [] });

    await getJson(base, "/api/github/repos?scope=discover&q=factory+console");
    assert.deepEqual(calls, [
      { scope: "mine", q: "" },
      { scope: "discover", q: "factory console" },
    ]);
  });
});

test("GET /api/github/repos rejects an unknown scope with 400", async () => {
  await withServer(fakeSources(), async (base) => {
    const { status, body } = await getJson(base, "/api/github/repos?scope=everyone");
    assert.equal(status, 400);
    assert.match(body.error, /scope must be mine or discover/);
  });
});

test("GET /api/github/repos keeps repos empty when gh is unavailable", async () => {
  const sources = fakeSources({
    repos: async (scope) => ({ scope, repos: [], error: "github unavailable: gh is not authenticated" }),
  });

  await withServer(sources, async (base) => {
    const { status, body } = await getJson(base, "/api/github/repos?scope=mine");
    assert.equal(status, 200);
    assert.deepEqual(body.repos, []);
    assert.match(body.error, /github unavailable/);
  });
});

test("every handoff write endpoint answers 501 with the reason", async () => {
  await withServer(fakeSources(), async (base) => {
    const writes = [
      "/api/projects",
      "/api/projects/attach",
      "/api/projects/fork",
      "/api/setup/model",
      "/api/lanes/any-task/kill",
      "/api/rooms/any-room/message",
    ];

    for (const path of writes) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      });
      const body = await res.json();
      assert.equal(res.status, 501, path);
      assert.equal(body.endpoint.startsWith("POST "), true, path);
      assert.match(body.error, /is not available in the local build/, path);
      assert.equal(typeof body.reason, "string", path);
      assert.ok(body.reason.length > 0, `${path} names why`);
      assert.equal(body.local, true);
    }
  });
});

test("GET /ws answers 501 because the stream is not wired", async () => {
  await withServer(fakeSources(), async (base) => {
    const { status, body } = await getJson(base, "/ws");
    assert.equal(status, 501);
    assert.equal(body.endpoint, "WS /ws");
    assert.match(body.reason, /event stream/);
  });
});

test("a WebSocket upgrade is refused in the wire protocol", async () => {
  await withServer(fakeSources(), async (base, port) => {
    const reply = await new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1", () => {
        socket.write(
          [
            "GET /ws HTTP/1.1",
            "Host: 127.0.0.1",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version: 13",
            "",
            "",
          ].join("\r\n"),
        );
      });
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString("utf8");
      });
      socket.on("end", () => resolve(data));
      socket.on("close", () => resolve(data));
      socket.on("error", reject);
    });

    assert.match(reply, /^HTTP\/1\.1 501 Not Implemented/);
    assert.match(reply, /"endpoint":"WS \/ws"/);
  });
});

test("an unknown route is a 404 and a wrong method is a 405", async () => {
  await withServer(fakeSources(), async (base) => {
    const missing = await getJson(base, "/api/nope");
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /no route/);

    const wrongMethod = await getJson(base, "/api/crews", { method: "POST" });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.body.allow, "GET");
  });
});

test("a source that throws is a 500, not a hung request", async () => {
  const sources = fakeSources({
    crews: async () => {
      throw new Error("snapshot exploded");
    },
  });

  await withServer(sources, async (base) => {
    const { status, body } = await getJson(base, "/api/crews");
    assert.equal(status, 500);
    assert.match(body.error, /snapshot exploded/);
  });
});
