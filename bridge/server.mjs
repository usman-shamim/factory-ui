#!/usr/bin/env node
/**
 * The local factory bridge: a dependency-free Node HTTP server that serves the
 * Factory Console read models from this machine's Firstmate home.
 *
 *   npm run bridge            # 127.0.0.1:8787, FM_HOME or the default home
 *   FM_HOME=/path npm run bridge
 *   FM_BRIDGE_PORT=8788 npm run bridge
 *
 * Read endpoints (shapes: factory-handoff-2026-11-16.md §3, or DEPLOY.md):
 *
 *   GET  /healthz
 *   GET  /api/crews
 *   GET  /api/gate
 *   GET  /api/setup
 *   GET  /api/projects
 *   GET  /api/rooms            (the app's startup read; handoff §3 full list)
 *   GET  /api/github/repos?scope=mine|discover&q=
 *
 * POST /api/session mints the session both clients ask for on mount. It is the
 * only accepted method, as on the VM's edge build.
 *
 * Write endpoints are listed in WRITE_ENDPOINTS and answer 501 with the reason
 * they are unavailable in this build. The next task fills them in here.
 *
 * Local auth is deliberately absent: /api/session names the local mode in `via`,
 * and every endpoint accepts the request with or without a token. There is no
 * SSO, JWT, HMAC webhook or CORS in this build, and nothing mutates the fleet.
 */
import http from "node:http";
import { pathToFileURL } from "node:url";

import { LOCAL_NO_STREAM_REASON, unavailable } from "./data.mjs";
import { createSources, DEFAULT_FM_HOME } from "./sources.mjs";

/** Every write endpoint from the handoff. Kept in code and in DEPLOY.md. */
export const WRITE_ENDPOINTS = [
  { method: "POST", path: "/api/projects", why: "creating a GitHub repository is a write to the account" },
  { method: "POST", path: "/api/projects/attach", why: "attaching a repository queues fleet registration" },
  { method: "POST", path: "/api/projects/fork", why: "forking creates a repository in the account" },
  { method: "POST", path: "/api/setup/model", why: "rewriting the dispatch default mutates fleet config" },
  { method: "POST", path: "/api/lanes/:id/kill", pattern: /^\/api\/lanes\/[^/]+\/kill$/, why: "killing a lane tears down a running crew" },
  { method: "POST", path: "/api/rooms/:id/message", pattern: /^\/api\/rooms\/[^/]+\/message$/, why: "steering a crew writes to a live session" },
];

/** Read paths, used to answer 405 instead of 404 for the wrong method. */
const READ_PATHS = [
  "/healthz",
  "/api/session",
  "/api/crews",
  "/api/gate",
  "/api/setup",
  "/api/projects",
  "/api/rooms",
  "/api/github/repos",
];

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
    "x-factory-bridge": "local",
    ...extraHeaders,
  });
  res.end(payload);
}

function matchWriteEndpoint(method, pathname) {
  return WRITE_ENDPOINTS.find(
    (endpoint) =>
      endpoint.method === method &&
      (endpoint.pattern ? endpoint.pattern.test(pathname) : endpoint.path === pathname),
  );
}

/**
 * Create the server with injectable sources so the shapes can be tested without
 * a fleet. `sources` defaults to the real Firstmate home.
 */
export function createServer({ sources = createSources(), log = () => {} } = {}) {
  const startedAt = Date.now();

  const server = http.createServer(async (req, res) => {
    const begin = Date.now();
    const method = (req.method ?? "GET").toUpperCase();
    let pathname = req.url ?? "/";

    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      pathname = url.pathname.replace(/\/+$/, "") || "/";

      const write = matchWriteEndpoint(method, pathname);
      if (write) {
        req.resume(); // drain an unexpected body so the 501 is not a reset
        sendJson(res, 501, unavailable(`${write.method} ${write.path}`, write.why));
        return;
      }

      if (pathname === "/ws") {
        req.resume();
        sendJson(res, 501, unavailable("WS /ws", LOCAL_NO_STREAM_REASON));
        return;
      }

      if (method === "GET" && pathname === "/healthz") {
        sendJson(res, 200, {
          ok: true,
          service: "factory-bridge",
          mode: "local",
          home: sources.fmHome,
          uptimeMs: Date.now() - startedAt,
        });
        return;
      }

      if (method === "POST" && pathname === "/api/session") {
        sendJson(res, 200, await sources.session());
        return;
      }

      if (method === "GET" && pathname === "/api/projects") {
        sendJson(res, 200, { projects: await sources.projects() });
        return;
      }

      if (method === "GET" && pathname === "/api/crews") {
        sendJson(res, 200, await sources.crews());
        return;
      }

      if (method === "GET" && pathname === "/api/gate") {
        sendJson(res, 200, await sources.gate());
        return;
      }

      if (method === "GET" && pathname === "/api/setup") {
        sendJson(res, 200, await sources.setup());
        return;
      }

      if (method === "GET" && pathname === "/api/rooms") {
        sendJson(res, 200, await sources.rooms());
        return;
      }

      if (method === "GET" && pathname === "/api/github/repos") {
        const scope = url.searchParams.get("scope") ?? "mine";
        if (scope !== "mine" && scope !== "discover") {
          sendJson(res, 400, {
            error: "scope must be mine or discover",
            scope,
            endpoint: "GET /api/github/repos",
          });
          return;
        }
        sendJson(res, 200, await sources.repos(scope, url.searchParams.get("q") ?? ""));
        return;
      }

      if (READ_PATHS.includes(pathname)) {
        sendJson(res, 405, {
          error: `${method} is not allowed on ${pathname}`,
          allow: pathname === "/api/session" ? "POST" : "GET",
        });
        return;
      }

      sendJson(res, 404, { error: "no route", method, path: pathname });
    } catch (error) {
      sendJson(res, 500, { error: String(error?.message ?? error), path: pathname });
    } finally {
      log(`${method} ${pathname} ${res.statusCode} ${Date.now() - begin}ms`);
    }
  });

  // A WebSocket handshake is an upgrade, not a normal request: answer it in the
  // wire protocol so the client sees the 501 body instead of a dropped socket.
  server.on("upgrade", (req, socket) => {
    socket.on("error", () => socket.destroy());
    try {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname.replace(/\/+$/, "") || "/";
      const body = Buffer.from(
        `${JSON.stringify(
          pathname === "/ws" ? unavailable("WS /ws", LOCAL_NO_STREAM_REASON) : { error: "no route", path: pathname },
        )}\n`,
        "utf8",
      );
      const status = pathname === "/ws" ? "501 Not Implemented" : "404 Not Found";
      socket.write(
        `HTTP/1.1 ${status}\r\n` +
          "content-type: application/json; charset=utf-8\r\n" +
          `content-length: ${body.length}\r\n` +
          "connection: close\r\n\r\n",
      );
      socket.end(body);
      log(`UPGRADE ${pathname} ${status.slice(0, 3)}`);
    } catch {
      socket.destroy();
    }
  });

  return server;
}

/** Start the bridge. Host is fixed to loopback by design. */
export function startServer({
  port = Number(process.env.FM_BRIDGE_PORT ?? 8787),
  host = "127.0.0.1",
  fmHome = process.env.FM_HOME || DEFAULT_FM_HOME,
  log = (line) => console.log(line),
} = {}) {
  const sources = createSources({ fmHome });
  const server = createServer({ sources, log: () => {} });

  server.on("error", (error) => {
    if (error?.code === "EADDRINUSE") {
      console.error(`factory-bridge: ${host}:${port} is already in use (stop the other bridge, or set FM_BRIDGE_PORT)`);
    } else {
      console.error(`factory-bridge: ${error?.message ?? error}`);
    }
    process.exit(1);
  });

  server.listen(port, host, () => {
    log(`factory-bridge listening on http://${host}:${port}`);
    log(`  home: ${fmHome}`);
    log(`  read: /healthz /api/projects /api/rooms /api/crews /api/gate /api/setup /api/github/repos`);
    log(`  session: POST /api/session`);
    log(`  writes and /ws answer 501 in this local build`);
  });

  const shutdown = (signal) => {
    log(`factory-bridge: ${signal}, closing`);
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return server;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  startServer({ log: (line) => console.log(line) });
}
