import { useEffect, useState } from "react";
import { api } from "./useAurora";

const OFFLINE = "Could not reach Aurora backend";

/* ---------- memory ---------- */
export function Memory({ onError }) {
  const [items, setItems] = useState(null);
  const [text, setText] = useState("");
  const load = () => api.get("/memory").then(setItems).catch(() => onError(OFFLINE));
  useEffect(() => { load(); }, []);
  const add = async () => {
    if (!text.trim()) return;
    await api.post("/memory", { text }).catch(() => onError(OFFLINE));
    setText(""); load();
  };
  return (
    <div className="sec">
      <p className="hint">Facts Aurora should remember about you. They are added to every conversation. Aurora also saves things when you ask her to remember them.</p>
      <div className="row">
        <input value={text} placeholder="For example: I use Fish shell and prefer short answers"
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="btn primary" onClick={add} disabled={!text.trim()}>Remember</button>
      </div>
      {items?.length === 0 && <div className="empty">Nothing remembered yet.</div>}
      {items?.map((m) => (
        <div key={m.id} className="item">
          <span>{m.text}</span>
          <button className="btn" onClick={async () => { await api.del(`/memory/${m.id}`); load(); }}>Forget</button>
        </div>
      ))}
    </div>
  );
}

/* ---------- skills ---------- */
export function Skills({ onError }) {
  const [items, setItems] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { api.get("/skills").then(setItems).catch(() => onError(OFFLINE)); }, []);
  if (!items) return <div className="empty">Loading skills…</div>;
  const upd = (id, k, v) => { setItems(items.map((i) => (i.id === id ? { ...i, [k]: v } : i))); setSaved(false); };
  const save = () => api.put("/skills", items.filter((i) => i.title.trim() || i.description.trim()))
    .then((d) => { setItems(d); setSaved(true); }).catch(() => onError("Could not save skills"));
  return (
    <div className="sec">
      <p className="hint">Reusable procedures Aurora sees in every conversation. You can edit them here, and Aurora can learn a missing skill when that option is enabled in Settings.</p>
      {items.map((i) => (
        <div key={i.id} className="card">
          <input placeholder="Skill name" value={i.title} onChange={(e) => upd(i.id, "title", e.target.value)} />
          <textarea rows={2} placeholder="What it does and when to use it" value={i.description}
            onChange={(e) => upd(i.id, "description", e.target.value)} />
          <div className="row end"><button className="btn" onClick={() => { setItems(items.filter((x) => x.id !== i.id)); setSaved(false); }}>Remove</button></div>
        </div>
      ))}
      {!items.length && <div className="empty">No skills yet.</div>}
      <div className="row">
        <button className="btn" onClick={() => { setItems([...items, { id: String(Date.now()), title: "", description: "" }]); setSaved(false); }}>Add skill</button>
        <button className="btn primary" onClick={save}>Save skills</button>
        {saved && <span className="hint">Saved</span>}
      </div>
    </div>
  );
}

/* ---------- tools (MCP servers) ---------- */
const splitArgs = (s) => (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^(["'])(.*)\1$/, "$2"));
const joinArgs = (a = []) => a.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(" ");
const pairs = (text, sep) => Object.fromEntries(text.split("\n").map((l) => l.trim()).filter((l) => l.includes(sep))
  .map((l) => [l.slice(0, l.indexOf(sep)).trim(), l.slice(l.indexOf(sep) + 1).trim()]));
const EMPTY = { name: "", command: "", args: "", env: "", url: "", headers: "" };

const STATE_LABEL = { connected: "connected", connecting: "connecting…", error: "failed", off: "off" };

export function Tools({ onError }) {
  const [st, setSt] = useState({ servers: [], tool_count: 0 });
  const refresh = () => api.get("/mcp/status").then(setSt).catch(() => {});
  useEffect(() => { refresh(); const t = setInterval(refresh, 2000); return () => clearInterval(t); }, []);
  const reconnect = () => api.post("/mcp/reload", {}).then(() => setTimeout(refresh, 400)).catch(() => onError(OFFLINE));
  const [cfg, setCfg] = useState(null);
  const [path, setPath] = useState("");
  const [raw, setRaw] = useState("");
  const [rawErr, setRawErr] = useState("");
  const [remote, setRemote] = useState(false);
  const [f, setF] = useState(EMPTY);

  const apply = (d) => { setCfg(d.config); setPath(d.path); setRaw(JSON.stringify(d.config, null, 2)); setRawErr(""); };
  useEffect(() => { api.get("/mcp").then(apply).catch(() => onError(OFFLINE)); }, []);
  if (!cfg) return <div className="empty">Loading tools…</div>;

  const servers = cfg.mcpServers || {};
  const save = (next) => api.put("/mcp", next).then((d) => { apply(d); setTimeout(refresh, 400); }).catch(() => onError("Could not save the tools file. Check each server has a command or a URL."));
  const setServers = (s) => save({ ...cfg, mcpServers: s });
  const toggle = (n) => {
    const { disabled, ...rest } = servers[n];
    setServers({ ...servers, [n]: disabled ? rest : { ...rest, disabled: true } });
  };
  const remove = (n) => { const { [n]: _, ...rest } = servers; setServers(rest); };
  const add = () => {
    let entry;
    if (remote) {
      const headers = pairs(f.headers, ":");
      entry = { url: f.url.trim(), ...(Object.keys(headers).length ? { headers } : {}) };
    } else {
      const env = pairs(f.env, "=");
      entry = { command: f.command.trim(), args: splitArgs(f.args), ...(Object.keys(env).length ? { env } : {}) };
    }
    setServers({ ...servers, [f.name.trim()]: entry });
    setF(EMPTY);
  };
  const saveRaw = () => { try { save(JSON.parse(raw)); } catch { setRawErr("That isn't valid JSON."); } };
  const names = Object.keys(servers);
  const ready = f.name.trim() && (remote ? /^https?:\/\//.test(f.url.trim()) : f.command.trim());

  return (
    <div className="sec">
      <p className="hint">Tool servers (MCP) Aurora can use: a local command or a remote URL. Saved to <code>{path}</code>. Aurora connects to enabled servers and lists their tools in every conversation. Tools that change things wait for your review unless Command mode in Settings allows them.</p>
      <div className="row between">
        <span className="hint">{st.tool_count} tool{st.tool_count === 1 ? "" : "s"} available to Aurora</span>
        <button className="btn" onClick={reconnect}>Reconnect</button>
      </div>
      {!names.length && <div className="empty">No tool servers yet. Add one below.</div>}
      {names.map((n) => {
        const s = servers[n];
        return (
          <div key={n} className={`card ${s.disabled ? "off" : ""}`}>
            <div className="row between">
              <b>{n} <span className="tag">{s.url ? "remote" : "local"}</span></b>
              <span className="row">
                <button className="btn" onClick={() => toggle(n)}>{s.disabled ? "Turn on" : "Turn off"}</button>
                <button className="btn" onClick={() => remove(n)}>Remove</button>
              </span>
            </div>
            <code className="cmd">{s.url || `${s.command} ${joinArgs(s.args)}`}</code>
            {(() => {
              const x = st.servers.find((v) => v.name === n);
              if (!x) return null;
              return (
                <span className={`hint srv ${x.state}`}>
                  {STATE_LABEL[x.state] || x.state}
                  {x.state === "connected" && ` · ${x.tools.length} tool${x.tools.length === 1 ? "" : "s"}: ${x.tools.slice(0, 6).join(", ")}${x.tools.length > 6 ? "…" : ""}`}
                  {x.state === "error" && x.error ? ` · ${x.error}` : ""}
                </span>
              );
            })()}
            {s.env && <span className="hint">{Object.keys(s.env).length} environment variable(s)</span>}
            {s.headers && <span className="hint">{Object.keys(s.headers).length} header(s)</span>}
          </div>
        );
      })}
      <div className="card">
        <div className="row between">
          <b>Add a tool server</b>
          <span className="row seg">
            <button className={`btn ${!remote ? "primary" : ""}`} onClick={() => setRemote(false)}>Local command</button>
            <button className={`btn ${remote ? "primary" : ""}`} onClick={() => setRemote(true)}>Remote URL</button>
          </span>
        </div>
        <input placeholder="Name (filesystem)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        {remote ? (
          <>
            <input placeholder="https://example.com/mcp" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
            <textarea rows={2} placeholder={"Headers, one per line (optional)\nAuthorization: Bearer abc123"} value={f.headers}
              onChange={(e) => setF({ ...f, headers: e.target.value })} />
          </>
        ) : (
          <>
            <div className="row">
              <input placeholder="Command (npx)" value={f.command} onChange={(e) => setF({ ...f, command: e.target.value })} />
              <input placeholder="Arguments (-y @modelcontextprotocol/server-filesystem /home/me)" value={f.args}
                onChange={(e) => setF({ ...f, args: e.target.value })} />
            </div>
            <textarea rows={2} placeholder={"Environment, one per line (optional)\nAPI_KEY=abc123"} value={f.env}
              onChange={(e) => setF({ ...f, env: e.target.value })} />
          </>
        )}
        <div className="row"><button className="btn primary" disabled={!ready} onClick={add}>Add server</button></div>
      </div>
      <details className="card">
        <summary>Edit as JSON</summary>
        <textarea className="mono" rows={10} value={raw} spellCheck={false} onChange={(e) => setRaw(e.target.value)} />
        <div className="row"><button className="btn primary" onClick={saveRaw}>Save JSON</button>{rawErr && <span className="bad">{rawErr}</span>}</div>
      </details>
    </div>
  );
}

/* ---------- system prompt ---------- */
export function Prompt({ onError }) {
  const [text, setText] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { api.get("/settings").then((s) => setText(s.system_prompt)).catch(() => onError(OFFLINE)); }, []);
  if (text === null) return <div className="empty">Loading prompt…</div>;
  const save = (v) => api.post("/settings", { system_prompt: v }).then((s) => { setText(s.system_prompt); setSaved(true); }).catch(() => onError(OFFLINE));
  return (
    <div className="sec">
      <p className="hint">Instructions Aurora follows in every conversation. Your memories are added after this text.</p>
      <textarea className="mono" rows={14} value={text} onChange={(e) => { setText(e.target.value); setSaved(false); }} />
      <div className="row">
        <button className="btn primary" onClick={() => save(text)}>Save prompt</button>
        <button className="btn" onClick={() => save("")}>Reset to default</button>
        {saved && <span className="hint">Saved</span>}
      </div>
    </div>
  );
}
