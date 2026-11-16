import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UserMessageBubble, AssistantMessageBubble } from "../../code-examples/ChatMessageBubbles";
import { StreamingDiffViewer } from "../../code-examples/StreamingDiffViewer";

const BRIDGE_URL = (import.meta.env.VITE_BRIDGE_URL ?? "").replace(/\/+$/, "");
const LEGACY_TOKEN = import.meta.env.VITE_BRIDGE_TOKEN ?? "";

interface Room {
  id: string;
  task: string;
  window: string | null;
  branch: string | null;
  pr: string | null;
  status: string;
}

interface Project {
  name: string;
  mode: string | null;
  yolo: boolean;
  description: string;
  repo: string | null;
}

interface Wire {
  type: string;
  role?: string;
  text?: string;
  tool?: string;
  args?: unknown;
  at?: string | null;
  session?: string;
}

let sessionToken = "";
let sessionExpiry = 0;

/**
 * Session mode: no secret ships in the bundle. The bridge verifies the Cloudflare
 * Access assertion and mints a 15-minute JWT, refreshed before it expires. The
 * legacy static token is only a fallback when no session can be minted.
 */
async function ensureSession(force = false): Promise<string> {
  if (!force && sessionToken && Date.now() < sessionExpiry - 60_000) return sessionToken;
  if (BRIDGE_URL) {
    try {
      const res = await fetch(`${BRIDGE_URL}/api/session`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) {
        const body = (await res.json()) as { token: string; expiresIn?: number };
        if (body.token) {
          sessionToken = body.token;
          sessionExpiry = Date.now() + (body.expiresIn ?? 900) * 1000;
          return sessionToken;
        }
      }
    } catch {
      /* fall back to the legacy token */
    }
  }
  return LEGACY_TOKEN;
}

function extractDiff(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const rec = args as Record<string, unknown>;
  for (const key of ["patch", "diff", "content"]) {
    const v = rec[key];
    if (typeof v === "string" && (v.includes("@@") || v.includes("---"))) return v;
  }
  return null;
}

/**
 * cds-theme.css ships the dark palette as [data-mode="dark"], which flips the
 * whole neutral ramp. Nothing ever set it, so the UI stayed light.
 */
function useTheme(): { mode: "light" | "dark"; toggle: () => void } {
  const [mode, setMode] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("factory-theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
  });
  useEffect(() => {
    document.documentElement.dataset.mode = mode;
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("factory-theme", mode);
  }, [mode]);
  return { mode, toggle: () => setMode((m) => (m === "dark" ? "light" : "dark")) };
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => window.matchMedia?.(query)?.matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

export default function App() {
  const { mode, toggle } = useTheme();
  const narrow = useMediaQuery("(max-width: 760px)");
  const [navOpen, setNavOpen] = useState(false);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [events, setEvents] = useState<Wire[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<"idle" | "live" | "down">("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [panel, setPanel] = useState<"none" | "new" | "attach">("none");
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const [attachRepo, setAttachRepo] = useState("");
  const [queued, setQueued] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const applyRooms = useCallback((data: { rooms?: Room[] }) => {
    setRooms(data.rooms ?? []);
    setActive((prev) => prev ?? data.rooms?.[0]?.id ?? null);
  }, []);

  const loadRooms = useCallback(async (): Promise<void> => {
    const token = await ensureSession();
    if (!token) {
      setNotice("Could not establish a session. The bridge did not accept the SSO identity.");
      return;
    }
    try {
      let res = await fetch(`${BRIDGE_URL}/api/rooms`, { headers: token ? { "X-Farm-Token": token } : {} });
      if (res.status === 401) {
        const fresh = await ensureSession(true);
        res = await fetch(`${BRIDGE_URL}/api/rooms`, { headers: fresh ? { "X-Farm-Token": fresh } : {} });
      }
      if (!res.ok) throw new Error(`rooms ${res.status}`);
      applyRooms((await res.json()) as { rooms?: Room[] });
      setNotice(null);
    } catch (e) {
      setNotice(`Could not list rooms: ${(e as Error).message}`);
    }
  }, [applyRooms]);

  useEffect(() => {
    if (!BRIDGE_URL) {
      setStatus("down");
      setNotice("VITE_BRIDGE_URL must be set at build time.");
      return;
    }
    let cancelled = false;
    let ws: WebSocket | null = null;

    void loadProjects();
    void loadRooms().then(() => {
      if (cancelled) return;
      void ensureSession().then((token) => {
        if (cancelled || !token) return;
        const wsBase = BRIDGE_URL.replace(/^http/, "ws");
        // The edge gate authenticates the handshake; a token in the query
        // string would leak into access logs, so none is sent here.
        ws = new WebSocket(`${wsBase}/ws`);
        wsRef.current = ws;
        ws.onopen = () => setStatus("live");
        ws.onerror = () => setStatus("down");
        ws.onclose = () => setStatus("down");
        ws.onmessage = (ev) => {
          try {
            const wire = JSON.parse(ev.data as string) as Wire;
            if (wire.type === "hello" || wire.type === "error") return;
            setEvents((prev) => [...prev.slice(-400), wire]);
          } catch {
            /* ignore malformed frame */
          }
        };
      });
    });

    // Refresh ahead of expiry so a long-lived tab keeps working.
    const timer = window.setInterval(() => void ensureSession(true), 12 * 60 * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      ws?.close();
    };
  }, [loadRooms]);

  const loadProjects = useCallback(async (): Promise<void> => {
    const token = await ensureSession();
    if (!token) return;
    try {
      const res = await fetch(`${BRIDGE_URL}/api/projects`, { headers: { "X-Farm-Token": token } });
      if (!res.ok) return;
      const body = (await res.json()) as { projects?: Project[] };
      setProjects(body.projects ?? []);
    } catch {
      /* keep the previous list rather than blanking the sidebar */
    }
  }, []);

  const postJson = async (
    path: string,
    payload: unknown,
  ): Promise<{ ok: boolean; body: Record<string, unknown>; status: number }> => {
    const token = await ensureSession();
    const res = await fetch(`${BRIDGE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { "X-Farm-Token": token } : {}) },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, body, status: res.status };
  };

  const createProject = async (): Promise<void> => {
    const name = newName.trim();
    if (!name) return;
    const r = await postJson("/api/projects", { name, description: newDesc.trim(), visibility });
    if (!r.ok) {
      setNotice(String(r.body.error ?? `Create failed (${r.status})`));
      return;
    }
    setQueued(name);
    setNewName("");
    setNewDesc("");
    setPanel("none");
    setNotice(`Created ${name}. Registration is queued for the Captain.`);
    void loadProjects();
  };

  const attachExisting = async (): Promise<void> => {
    const repo = attachRepo.trim();
    if (!repo) return;
    const r = await postJson("/api/projects/attach", { repo });
    if (!r.ok) {
      setNotice(String(r.body.error ?? `Attach failed (${r.status})`));
      return;
    }
    setQueued(repo.split("/")[1] ?? repo);
    setAttachRepo("");
    setPanel("none");
    setNotice(`Attached ${repo}. Registration is queued for the Captain.`);
    void loadProjects();
  };

  useEffect(() => {
    if (!queued) return;
    if (projects.some((p) => p.name === queued)) {
      setQueued(null);
      return;
    }
    const timer = window.setInterval(() => void loadProjects(), 5000);
    return () => window.clearInterval(timer);
  }, [queued, projects, loadProjects]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || !active) return;
    setDraft("");
    try {
      const token = await ensureSession();
      const res = await fetch(`${BRIDGE_URL}/api/rooms/${encodeURIComponent(active)}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { "X-Farm-Token": token } : {}) },
        body: JSON.stringify({ text }),
      });
      const body = (await res.json()) as { delivered?: boolean; target?: string };
      if (!res.ok || !body.delivered) setNotice(`Message not delivered (${res.status})`);
      else if (body.target === "captain") setNotice("Task not spawned yet — forwarded to the Captain.");
      else setNotice(null);
    } catch (e) {
      setNotice(`Send failed: ${(e as Error).message}`);
    }
  };

  const kinds = useMemo(() => {
    let tools = 0;
    let diffs = 0;
    for (const e of events) {
      if (e.type === "tool_call") tools += 1;
      if (extractDiff(e.args)) diffs += 1;
    }
    return { tools, diffs };
  }, [events]);

  return (
    <div style={narrow ? narrowShell : shell}>
      {narrow && navOpen && (
        <button
          aria-label="Close navigation"
          onClick={() => setNavOpen(false)}
          style={backdrop}
        />
      )}
      <aside style={narrow ? (navOpen ? drawerOpen : drawer) : sidebar}>
        <header style={sideHead}>
          <strong style={{ fontSize: 14 }}>Factory</strong>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={badge(status)}>{status === "live" ? "live" : status === "down" ? "offline" : "…"}</span>
            <button onClick={toggle} style={refreshBtn} title="Toggle light and dark" aria-label="Toggle light and dark">
              {mode === "dark" ? "☀" : "☾"}
            </button>
          </span>
        </header>
        <div style={{ padding: "10px 12px 2px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 11, opacity: 0.6 }}>Projects ({projects.length})</span>
          <span style={{ display: "flex", gap: 4 }}>
            <button style={miniBtn} onClick={() => setPanel(panel === "new" ? "none" : "new")} title="Create a new GitHub repository">
              +
            </button>
            <button style={miniBtn} onClick={() => setPanel(panel === "attach" ? "none" : "attach")} title="Attach an existing repository">
              ⇣
            </button>
          </span>
        </div>
        {projects.map((p) => (
          <button
            key={p.name}
            style={row(false)}
            title={p.repo ?? p.name}
            onClick={() => setNotice(p.repo ? `${p.name} → ${p.repo}` : `${p.name} has no resolved repo`)}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</span>
            <span style={pill}>{p.yolo ? "yolo" : (p.mode ?? "—")}</span>
          </button>
        ))}
        {queued && !projects.some((p) => p.name === queued) && (
          <div style={{ padding: "2px 12px 6px", fontSize: 11, opacity: 0.6 }}>{queued}: queued for the Captain…</div>
        )}
        <div style={{ padding: "10px 12px 2px", fontSize: 11, opacity: 0.6 }}>Rooms ({rooms.length})</div>
        {rooms.map((r) => (
          <button
            key={r.id}
            onClick={() => {
              setActive(r.id);
              setNavOpen(false);
            }}
            style={row(active === r.id)}
            title={r.branch ?? r.id}
          >
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {r.task}
            </span>
            <span style={pill}>{r.status}</span>
          </button>
        ))}
        {rooms.length === 0 && (
          <div style={{ padding: 12, fontSize: 12, opacity: 0.6 }}>No rooms yet.</div>
        )}
        <div style={{ marginTop: "auto", padding: 12, fontSize: 11, opacity: 0.55 }}>
          {kinds.tools} tool calls · {kinds.diffs} diffs
        </div>
      </aside>

      <main style={main}>
        <header style={mainHead}>
          {narrow && (
            <button onClick={() => setNavOpen(true)} style={refreshBtn} aria-label="Open navigation">
              ☰
            </button>
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {active ?? "No room selected"}
            </div>
            <div style={{ fontSize: 11, opacity: 0.6 }}>{BRIDGE_URL || "bridge URL not configured"}</div>
          </div>
          <button onClick={() => void loadRooms()} style={refreshBtn}>
            Refresh
          </button>
        </header>

        {notice && <div style={noticeBar}>{notice}</div>}

        {panel !== "none" && (
          <div style={formCard}>
            {panel === "new" ? (
              <>
                <div style={formTitle}>New GitHub repository</div>
                <label style={formLabel}>Name</label>
                <input style={formInput} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="my-project" />
                <label style={formLabel}>Description</label>
                <input style={formInput} value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="What this project is" />
                <div style={formRow}>
                  {(["private", "public"] as const).map((v) => (
                    <label key={v} style={radioLabel}>
                      <input type="radio" name="visibility" checked={visibility === v} onChange={() => setVisibility(v)} />
                      {v}
                    </label>
                  ))}
                </div>
                <div style={formRow}>
                  <button style={primaryBtn} onClick={() => void createProject()} disabled={!newName.trim()}>
                    Create repository
                  </button>
                  <button style={miniBtn} onClick={() => setPanel("none")}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={formTitle}>Attach an existing repository</div>
                <label style={formLabel}>Repository</label>
                <input style={formInput} value={attachRepo} onChange={(e) => setAttachRepo(e.target.value)} placeholder="owner/name" />
                <div style={formRow}>
                  <button style={primaryBtn} onClick={() => void attachExisting()} disabled={!attachRepo.trim()}>
                    Attach
                  </button>
                  <button style={miniBtn} onClick={() => setPanel("none")}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <div style={stream}>
          {events.length === 0 && (
            <div style={{ opacity: 0.55, fontSize: 13 }}>
              Waiting for live agent events…
            </div>
          )}
          {events.map((e, i) => {
            const diff = extractDiff(e.args);
            if (diff) {
              return (
                <StreamingDiffViewer
                  key={i}
                  rawDiff={diff}
                  filename={e.tool ?? "diff"}
                  isStreaming={i === events.length - 1}
                />
              );
            }
            if (e.type === "tool_call") {
              return (
                <div key={i} style={toolLine}>
                  <code style={{ fontSize: 12 }}>{e.tool}</code>
                  <span style={{ opacity: 0.6, fontSize: 11 }}>
                    {JSON.stringify(e.args ?? {}).slice(0, 160)}
                  </span>
                </div>
              );
            }
            if (e.type === "tool_result" && e.text) {
              return <LogAccordion key={i} label="result" text={e.text} />;
            }
            if (e.type === "message" && e.text) {
              return e.role === "user" ? (
                <UserMessageBubble key={i} text={e.text} time={e.at ?? ""} />
              ) : (
                <AssistantMessageBubble key={i} text={e.text} modelName={e.role} time={e.at ?? ""} />
              );
            }
            return null;
          })}
        </div>

        <footer style={composer}>
          <textarea
            value={draft}
            onChange={(ev) => setDraft(ev.target.value)}
            onKeyDown={(ev) => {
              if (ev.key === "Enter" && !ev.shiftKey) {
                ev.preventDefault();
                void send();
              }
            }}
            placeholder={active ? `Steer ${active}…` : "Select a room"}
            style={textArea}
            rows={2}
            disabled={!active}
          />
          <button
            onClick={() => void send()}
            style={narrow ? { ...sendBtn, width: "100%" } : sendBtn}
            disabled={!draft.trim() || !active}
          >
            Send
          </button>
        </footer>
      </main>
    </div>
  );
}

/**
 * Tool output is logged, not read: collapsed to one line by default so a burst of
 * bash/read results cannot bury the assistant's actual replies.
 */
function LogAccordion({ label, text }: { label: string; text: string }) {
  const firstLine = text.split("\n").find((line) => line.trim()) ?? "";
  const lineCount = text.split("\n").length;
  return (
    <details style={logDetails}>
      <summary style={logSummary}>
        <code style={logLabel}>{label}</code>
        <span style={logPreview}>{firstLine.replace(/\s+/g, " ").slice(0, 110)}</span>
        <span style={logCount}>{lineCount}L</span>
      </summary>
      <pre style={logPre}>{text}</pre>
    </details>
  );
}

const shell: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "260px 1fr",
  height: "100vh",
  fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
  color: "var(--cds-text-primary)",
  background: "var(--cds-bg-primary)",
};
const sidebar: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  borderRight: "1px solid var(--cds-border)",
  background: "var(--cds-bg-secondary)",
  overflowY: "auto",
};
const sideHead: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "14px 12px 8px",
};
const main: React.CSSProperties = { display: "flex", flexDirection: "column", minWidth: 0 };
const mainHead: React.CSSProperties = {
  padding: "12px 18px",
  borderBottom: "1px solid var(--cds-border)",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};
const refreshBtn: React.CSSProperties = {
  fontSize: 12,
  padding: "4px 10px",
  borderRadius: 8,
  border: "1px solid var(--cds-border)",
  color: "var(--cds-text-secondary)",
  background: "transparent",
  cursor: "pointer",
};
const stream: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "16px 18px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};
const composer: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  padding: 12,
  borderTop: "1px solid var(--cds-border)",
};
const textArea: React.CSSProperties = {
  flex: 1,
  resize: "none",
  borderRadius: 12,
  border: "1px solid var(--cds-border)",
  background: "var(--cds-bg-input)",
  color: "var(--cds-text-primary)",
  padding: "8px 10px",
  font: "inherit",
  fontSize: 13,
};
const sendBtn: React.CSSProperties = {
  borderRadius: 10,
  border: "1px solid rgba(0,0,0,.14)",
  padding: "0 16px",
  background: "var(--cds-clay)",
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
};
const logDetails: React.CSSProperties = {
  borderRadius: 8,
  background: "var(--cds-bg-neutral)",
  padding: "4px 10px",
};
const logSummary: React.CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 8,
  cursor: "pointer",
  listStyle: "none",
  fontSize: 11,
};
const logLabel: React.CSSProperties = { fontSize: 12, opacity: 0.7 };
const logPreview: React.CSSProperties = {
  flex: 1,
  opacity: 0.5,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const logCount: React.CSSProperties = { fontSize: 10, opacity: 0.4, whiteSpace: "nowrap" };
const logPre: React.CSSProperties = {
  margin: "6px 0 2px",
  padding: 0,
  maxHeight: 320,
  overflow: "auto",
  fontSize: 11,
  lineHeight: 1.45,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const toolLine: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "baseline",
  padding: "6px 10px",
  borderRadius: 8,
  background: "var(--cds-bg-neutral)",
};
const noticeBar: React.CSSProperties = {
  padding: "8px 18px",
  fontSize: 12,
  background: "color-mix(in srgb, #d99114 18%, transparent)",
  borderBottom: "1px solid var(--cds-border)",
};

function row(on: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    width: "100%",
    textAlign: "left",
    padding: "8px 12px",
    fontSize: 13,
    border: "none",
    borderLeft: on ? "2px solid var(--cds-clay)" : "2px solid transparent",
    background: on ? "var(--cds-bg-selected)" : "transparent",
    color: "var(--cds-text-primary)",
    cursor: "pointer",
  };
}

function badge(s: "idle" | "live" | "down"): React.CSSProperties {
  return {
    fontSize: 10,
    padding: "2px 7px",
    borderRadius: 999,
    color: s === "live" ? "var(--cds-clay)" : "var(--cds-text-secondary)",
    background:
      s === "live"
        ? "color-mix(in srgb, var(--cds-clay) 16%, transparent)"
        : s === "down"
          ? "color-mix(in srgb, #d1453b 18%, transparent)"
          : "var(--cds-bg-neutral)",
  };
}

const pill: React.CSSProperties = {
  fontSize: 10,
  padding: "1px 6px",
  borderRadius: 999,
  background: "var(--cds-bg-neutral)",
  whiteSpace: "nowrap",
};

const miniBtn: React.CSSProperties = {
  fontSize: 11,
  padding: "2px 8px",
  borderRadius: 8,
  border: "1px solid var(--cds-border)",
  background: "transparent",
  color: "var(--cds-text-secondary)",
  cursor: "pointer",
};
const formCard: React.CSSProperties = {
  margin: "12px 18px 0",
  padding: 14,
  borderRadius: 12,
  border: "1px solid var(--cds-border)",
  background: "var(--cds-bg-surface)",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const formTitle: React.CSSProperties = { fontSize: 13, fontWeight: 600, marginBottom: 2 };
const formLabel: React.CSSProperties = { fontSize: 11, color: "var(--cds-text-muted)" };
const formInput: React.CSSProperties = {
  fontSize: 13,
  padding: "7px 9px",
  borderRadius: 8,
  border: "1px solid var(--cds-border)",
  background: "var(--cds-bg-input)",
  color: "var(--cds-text-primary)",
  font: "inherit",
};
const formRow: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", marginTop: 4 };
const radioLabel: React.CSSProperties = {
  fontSize: 12,
  display: "flex",
  gap: 5,
  alignItems: "center",
  color: "var(--cds-text-secondary)",
};
const primaryBtn: React.CSSProperties = {
  fontSize: 12,
  padding: "7px 14px",
  borderRadius: 8,
  border: "none",
  background: "var(--cds-clay)",
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
};

const narrowShell: React.CSSProperties = {
  ...shell,
  gridTemplateColumns: "1fr",
  position: "relative",
};
const drawer: React.CSSProperties = {
  ...sidebar,
  position: "fixed",
  top: 0,
  bottom: 0,
  left: 0,
  width: "82vw",
  maxWidth: 300,
  zIndex: 30,
  borderRight: "1px solid var(--cds-border)",
  transform: "translateX(-102%)",
  transition: "transform 180ms ease",
  visibility: "hidden",
};
const drawerOpen: React.CSSProperties = {
  ...drawer,
  transform: "translateX(0)",
  visibility: "visible",
  boxShadow: "0 0 0 100vmax rgba(0,0,0,.45)",
};
const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 20,
  border: "none",
  padding: 0,
  background: "transparent",
  cursor: "pointer",
};
