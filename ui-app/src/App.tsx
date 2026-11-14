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

export default function App() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [events, setEvents] = useState<Wire[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<"idle" | "live" | "down">("idle");
  const [notice, setNotice] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const applyRooms = useCallback((data: { rooms?: Room[] }) => {
    setRooms(data.rooms ?? []);
    setActive((prev) => prev ?? data.rooms?.[0]?.id ?? null);
  }, []);

  const loadRooms = useCallback(async (): Promise<void> => {
    const token = await ensureSession();
    if (!token) {
      setNotice("Could not establish a session. Enable Cloudflare Access on this host.");
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

    void loadRooms().then(() => {
      if (cancelled) return;
      void ensureSession().then((token) => {
        if (cancelled || !token) return;
        const wsBase = BRIDGE_URL.replace(/^http/, "ws");
        ws = new WebSocket(`${wsBase}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`);
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
    <div style={shell}>
      <aside style={sidebar}>
        <header style={sideHead}>
          <strong style={{ fontSize: 14 }}>Factory</strong>
          <span style={badge(status)}>{status === "live" ? "live" : status === "down" ? "offline" : "…"}</span>
        </header>
        <div style={{ padding: "6px 12px", fontSize: 11, opacity: 0.6 }}>Rooms ({rooms.length})</div>
        {rooms.map((r) => (
          <button
            key={r.id}
            onClick={() => setActive(r.id)}
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
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{active ?? "No room selected"}</div>
            <div style={{ fontSize: 11, opacity: 0.6 }}>{BRIDGE_URL || "bridge URL not configured"}</div>
          </div>
          <button onClick={() => void loadRooms()} style={refreshBtn}>
            Refresh
          </button>
        </header>

        {notice && <div style={noticeBar}>{notice}</div>}

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
          <button onClick={() => void send()} style={sendBtn} disabled={!draft.trim() || !active}>
            Send
          </button>
        </footer>
      </main>
    </div>
  );
}

const shell: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "260px 1fr",
  height: "100vh",
  fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
  color: "var(--cds-text, #1f1e1d)",
  background: "var(--cds-bg-app, #faf9f7)",
};
const sidebar: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  borderRight: "1px solid rgba(0,0,0,.08)",
  background: "var(--cds-bg-sidebar, #f3f1ee)",
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
  borderBottom: "1px solid rgba(0,0,0,.08)",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};
const refreshBtn: React.CSSProperties = {
  fontSize: 12,
  padding: "4px 10px",
  borderRadius: 8,
  border: "1px solid rgba(0,0,0,.14)",
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
  gap: 8,
  padding: 12,
  borderTop: "1px solid rgba(0,0,0,.08)",
};
const textArea: React.CSSProperties = {
  flex: 1,
  resize: "none",
  borderRadius: 12,
  border: "1px solid rgba(0,0,0,.14)",
  padding: "8px 10px",
  font: "inherit",
  fontSize: 13,
};
const sendBtn: React.CSSProperties = {
  borderRadius: 10,
  border: "1px solid rgba(0,0,0,.14)",
  padding: "0 16px",
  background: "#c96442",
  color: "#fff",
  fontWeight: 600,
  cursor: "pointer",
};
const toolLine: React.CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "baseline",
  padding: "6px 10px",
  borderRadius: 8,
  background: "rgba(0,0,0,.035)",
};
const noticeBar: React.CSSProperties = {
  padding: "8px 18px",
  fontSize: 12,
  background: "#fff4e5",
  borderBottom: "1px solid rgba(0,0,0,.08)",
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
    borderLeft: on ? "2px solid #c96442" : "2px solid transparent",
    background: on ? "rgba(201,100,66,.10)" : "transparent",
    cursor: "pointer",
  };
}

function badge(s: "idle" | "live" | "down"): React.CSSProperties {
  return {
    fontSize: 10,
    padding: "2px 7px",
    borderRadius: 999,
    background: s === "live" ? "#dff3e3" : s === "down" ? "#fbe1de" : "#eee",
  };
}

const pill: React.CSSProperties = {
  fontSize: 10,
  padding: "1px 6px",
  borderRadius: 999,
  background: "rgba(0,0,0,.06)",
  whiteSpace: "nowrap",
};
