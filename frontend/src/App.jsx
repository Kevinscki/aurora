import { useEffect, useMemo, useRef, useState } from "react";
import { api, useAurora } from "./useAurora";
import { Memory, Skills, Tools, Prompt } from "./panels";
import { useVoiceInput } from "./voice";
import { Markdown } from "./markdown";
import { Controls, useControls } from "./controls";
import { Dropdown } from "./dropdown";

/* ---------- small pieces ---------- */
const ICONS = {
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
  live: <><circle cx="12" cy="12" r="2" /><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2" /></>,
  cam: <><path d="M3 7h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H3z" /><path d="M16 11l5-3v8l-5-3" /></>,
  send: <path d="M12 19V5M5 12l7-7 7 7" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  bolt: <path d="M13 2L4 14h7l-1 8 9-12h-7z" />,
  chev: <path d="M6 9l6 6 6-6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  trash: <path d="M5 7h14M10 11v6M14 11v6M7 7l1 12h8l1-12M9 7V4h6v3" />,
  min: <path d="M5 18h14" />,
};
const Icon = ({ n }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round">{ICONS[n]}</svg>
);

const STATUS_COLOR = {
  Idle: "#6b8575", Listening: "#52d688", Transcribing: "#52d688", Thinking: "#c3e88d",
  Working: "#e5c07b", Speaking: "#7ae8a5", Watching: "#7cc4ff", Error: "#f07178",
};
const RUN_LABEL = {
  waiting: "Waiting for review", running: "Running…", rejected: "Rejected", timeout: "Timed out",
  aborted: "Stopped", revise: "Sent back for changes",
};
const runLabel = (r) => (r.status === "done" ? `Ran, exit ${r.exit_code}` : RUN_LABEL[r.status] || r.status);

function parse(text) {
  const out = [];
  const re = /```(\w*)\n([\s\S]*?)(```|$)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: "text", v: text.slice(last, m.index) });
    out.push({ t: "code", lang: m[1], v: m[2].replace(/\n$/, "") });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

const Dot = ({ status }) => (
  <span className={`dot ${status === "Idle" ? "" : "live"}`} style={{ "--c": STATUS_COLOR[status] }} />
);

/* ---------- conversation ---------- */
function CodeBlock({ lang, code, run }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code">
      <div className="code-head">
        <span>{lang || "text"}</span>
        <button onClick={() => { navigator.clipboard?.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{code}</pre>
      {run && <div className={`code-status s-${run.status}`}>{runLabel(run)}</div>}
    </div>
  );
}

function Conversation({ a }) {
  const end = useRef(null);
  const runList = Object.values(a.runs);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [a.messages]);
  if (!a.messages.length)
    return <div className="empty">Ask Aurora to look something up, write a script, or work on your files.</div>;
  return (
    <div className="chat">
      {a.messages.map((m, i) => (
        <div key={i}>
          {a.ctxStart === i && a.ctxStart > 0 && <div className="ctx-marker">Earlier messages are outside the model's context</div>}
          <div className={`msg ${m.role}`}>
            {m.thinking && (
              <details className="thinking">
                <summary>Thinking…</summary>
                <div>{m.thinking}</div>
              </details>
            )}
            {parse(m.content).map((s, k) =>
              s.t === "text"
                ? (m.role === "assistant" ? <Markdown key={k} text={s.v} /> : <p key={k}>{s.v}</p>)
                : s.lang === "remember"
                  ? <div key={k} className="remembered">Remembered: {s.v.split("\n").map((x) => x.replace(/^[-•\s]+/, "")).filter(Boolean).join(" · ")}</div>
                  : <CodeBlock key={k} lang={s.lang} code={s.v} run={runList.find((r) => (r.orig || r.code).trim() === s.v.trim())} />
            )}
          </div>
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

/* ---------- console ---------- */
function RunCard({ run, a, onReturned }) {
  const waiting = run.status === "waiting";
  const [mode, setMode] = useState(null); // null | "edit" | "comment"
  const [text, setText] = useState("");
  const lines = run.code.replace(/\n$/, "").split("\n");
  const open = (m, v) => { setText(v); setMode(m); };
  const saveEdit = async () => { try { await a.editRun(run.id, text); setMode(null); } catch { a.setError("Could not save your edit"); } };
  const sendBack = async () => {
    const note = text.trim();
    await a.runAction(run.id, "r", note);
    a.send(`I didn't run the ${run.lang} script. ${note ? "My note: " + note : "Please revise it."}`);
    setMode(null); onReturned();
  };
  return (
    <div className="run">
      <div className="run-head">
        <b>{run.lang}{run.edited ? " (edited)" : ""}</b><span className={`s-${run.status}`}>{runLabel(run)}</span>
      </div>
      {mode === "edit" ? (
        <textarea className="mono edit" rows={Math.min(16, lines.length + 2)} value={text} spellCheck={false}
          onChange={(e) => setText(e.target.value)} />
      ) : (
        <div className="lines">
          {lines.map((l, i) => (
            <div key={i} className={`ln ${run.risky_lines?.includes(i + 1) ? "risky" : ""}`}>
              <i>{i + 1}</i><code>{l || " "}</code>
            </div>
          ))}
        </div>
      )}
      {run.risky_lines?.length > 0 && waiting && mode !== "edit" && (
        <div className="warn">Lines {run.risky_lines.join(", ")} look risky. Check them before running.</div>
      )}
      {mode === "comment" && (
        <div className="pad">
          <textarea rows={3} autoFocus placeholder="Tell Aurora what to change (optional)" value={text}
            onChange={(e) => setText(e.target.value)} />
        </div>
      )}
      {waiting && mode === "edit" && (
        <div className="actions">
          <button className="primary" onClick={saveEdit}>Save changes</button>
          <button onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}
      {waiting && mode === "comment" && (
        <div className="actions">
          <button className="primary" onClick={sendBack}>Send back</button>
          <button onClick={() => setMode(null)}>Cancel</button>
        </div>
      )}
      {waiting && !mode && (
        <div className="actions">
          <button className="primary" onClick={() => a.runAction(run.id, "y")}>Run</button>
          <button onClick={() => a.runAction(run.id, "n")}>Reject</button>
          <button onClick={() => a.runAction(run.id, "c")}>Copy</button>
          <button onClick={() => open("edit", run.code)}>Edit</button>
          <button onClick={() => open("comment", "")}>Return with comment</button>
          <button disabled title="Coming in a later milestone">Terminal</button>
        </div>
      )}
      {run.status === "running" && (
        <div className="actions"><button onClick={() => a.runAction(run.id, "ab")}>Stop</button></div>
      )}
      {run.output !== undefined && (
        <>
          <pre className="out">{run.output || "(no output)"}{run.truncated ? "\n… output cut off" : ""}</pre>
          <div className="meta">Exit {run.exit_code} · {run.duration}s</div>
        </>
      )}
    </div>
  );
}

function Console({ a, onReturned }) {
  const list = Object.values(a.runs).reverse();
  if (!list.length) return <div className="empty">Scripts Aurora wants to run will show up here for your review.</div>;
  return <div className="runs">{list.map((r) => <RunCard key={r.id} run={r} a={a} onReturned={onReturned} />)}</div>;
}

/* ---------- history ---------- */
function History({ a, onOpen }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState(null);
  const load = () => a.history(q).then(setItems).catch(() => a.setError("Could not reach Aurora backend"));
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [q]);
  return (
    <div className="hist">
      <div className="hist-bar">
        <input placeholder="Search conversations" value={q} onChange={(e) => setQ(e.target.value)} />
        <button onClick={() => { a.newChat(); onOpen(); }}><Icon n="plus" /> New chat</button>
      </div>
      {items?.length === 0 && <div className="empty">No conversations yet.</div>}
      {items?.map((c) => (
        <div key={c.id} className="hist-item">
          <button className="hist-open" onClick={async () => { await a.openConv(c.id); onOpen(); }}>
            <span>{c.title}</span>
            <small>{new Date(c.created * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</small>
          </button>
          <button className="icon" title="Delete" onClick={async () => { await a.deleteConv(c.id); load(); }}><Icon n="trash" /></button>
        </div>
      ))}
    </div>
  );
}

/* ---------- settings ---------- */
function Settings({ a }) {
  const [s, setS] = useState(null);
  const [voices, setVoices] = useState([]);
  const [saved, setSaved] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [test, setTest] = useState(null); // {ok, models?, error?} | "busy"
  useEffect(() => {
    a.getSettings().then(setS).catch(() => a.setError("Could not reach Aurora backend"));
    fetch("/voice/voices").then((r) => r.json()).then(setVoices).catch(() => {});
  }, []);
  if (!s) return <div className="empty">Loading settings…</div>;
  const set = (k, v) => { setS({ ...s, [k]: v }); setSaved(false); };
  const num = (k) => (e) => set(k, Number(e.target.value));
  const known = voices.some((v) => v.path === s.tts_model);
  const runTest = async () => {
    setTest("busy");
    try {
      setTest(await api.post("/llm/test", { llm_url: s.llm_url, llm_api: s.llm_api, api_key: clearKey ? "" : keyDraft }));
    } catch { setTest({ ok: false, error: "Could not reach Aurora backend" }); }
  };
  const save = async () => {
    const { model, llm_url, llm_api, max_messages, max_tokens, think, code_exec, tts_enabled, tts_model, tts_speed,
      stt_silence_seconds, stt_max_speech_seconds, learn_skills } = s;
    const patch = { model, llm_url, llm_api, max_messages, max_tokens, think, code_exec, tts_enabled, tts_model, tts_speed,
      stt_silence_seconds, stt_max_speech_seconds, learn_skills };
    if (clearKey) patch.api_key = "";
    else if (keyDraft) patch.api_key = keyDraft;  // not sent = keep the saved key
    try {
      setS(await a.saveSettings(patch));
      setKeyDraft(""); setClearKey(false); setSaved(true);
    } catch { a.setError("Could not save settings"); }
  };
  return (
    <div className="settings">
      <label>Model server address<input value={s.llm_url} placeholder="http://127.0.0.1:8080 or https://api.openai.com/v1" onChange={(e) => set("llm_url", e.target.value)} /></label>
      <div className="field-group">Server type
        <Dropdown value={s.llm_api} onChange={(v) => set("llm_api", v)} options={[
          { value: "openai", label: "llama.cpp / OpenAI-compatible (OpenAI, OpenRouter, Groq, LM Studio, ...)" },
          { value: "ollama", label: "Ollama" },
        ]} />
      </div>
      <label>API key (only for hosted servers)
        <input type="password" autoComplete="off" spellCheck={false} value={clearKey ? "" : keyDraft} disabled={clearKey}
          placeholder={s.api_key_set && !clearKey ? "Saved. Type to replace it" : clearKey ? "Will be removed on save" : "sk-..."}
          onChange={(e) => { setKeyDraft(e.target.value); setSaved(false); }} />
      </label>
      {s.api_key_set && (
        <label className="check"><input type="checkbox" checked={clearKey} onChange={(e) => { setClearKey(e.target.checked); setSaved(false); }} />Remove the saved key</label>
      )}
      <div className="field-group">Model name (optional for llama.cpp)
        <Dropdown editable value={s.model} placeholder="Pick a model or type its name"
          onChange={(v) => set("model", v)}
          options={(test?.models || []).map((m) => ({ value: m, label: m }))}
          onOpen={() => { if (test !== "busy" && !test?.ok) runTest(); }}
          note={test === "busy" ? "Loading models…" : test && !test.ok ? `${test.error}. Check the address and key above.` : "No models reported by the server. Type the name instead."} />
      </div>
      <div className="actions">
        <button onClick={runTest} disabled={test === "busy"}>{test === "busy" ? "Testing…" : "Test connection"}</button>
        {test && test !== "busy" && (test.ok
          ? <span className="meta ok">Connected · {test.models.length} model{test.models.length === 1 ? "" : "s"} found{test.models.length ? " (pick one in Model name)" : ""}</span>
          : <span className="meta bad">{test.error}</span>)}
      </div>
      <label>Messages sent to the model<input type="number" value={s.max_messages} onChange={num("max_messages")} /></label>
      <label>Token limit for context<input type="number" value={s.max_tokens} onChange={num("max_tokens")} /></label>
      <div className="field-group">Thinking
        <Dropdown value={s.think} onChange={(v) => set("think", v)} options={[
          { value: "off", label: "Off" }, { value: "auto", label: "Auto (coding tasks)" }, { value: "on", label: "Always" },
        ]} />
      </div>
      <label className="check"><input type="checkbox" checked={s.code_exec} onChange={(e) => set("code_exec", e.target.checked)} />Let Aurora propose and run scripts</label>
      <label className="check"><input type="checkbox" checked={s.learn_skills} onChange={(e) => set("learn_skills", e.target.checked)} />Let Aurora save new reusable skills it learns</label>
      <div className="meta">Auto-run, temperature and top-p are in the Controls tab.</div>
      <div className="field-group">Voice
        <Dropdown value={s.tts_model} onChange={(v) => set("tts_model", v)} note="No voices found" options={[
          ...(!known ? [{ value: s.tts_model, label: s.tts_model.split("/").pop() }] : []),
          ...voices.map((v) => ({ value: v.path, label: v.name })),
        ]} />
      </div>
      <label>Live listening pause before send ({s.stt_silence_seconds.toFixed(1)} seconds)
        <input type="range" min="0.5" max="10" step="0.5" value={s.stt_silence_seconds} onChange={num("stt_silence_seconds")} />
      </label>
      <label>Maximum continuous live utterance ({s.stt_max_speech_seconds} seconds)
        <input type="number" min="10" max="120" step="5" value={s.stt_max_speech_seconds} onChange={num("stt_max_speech_seconds")} />
      </label>
      <label>Speaking speed ({s.tts_speed < 1 ? "faster" : "slower"})
        <input type="range" min="0.7" max="1.3" step="0.025" value={s.tts_speed} onChange={num("tts_speed")} />
      </label>
      <label className="check"><input type="checkbox" checked={s.tts_enabled} onChange={(e) => set("tts_enabled", e.target.checked)} />Speak replies out loud</label>
      <div className="actions">
        <button className="primary" onClick={save}>Save settings</button>
        {saved && <span className="meta">Saved</span>}
      </div>
    </div>
  );
}

/* ---------- island ---------- */
// Window layout. The Electron window is always island size + this margin (room for the shadow), so the
// island never depends on the window's own size (the old 100vh/96vw CSS did, and shrank itself).
// Keep PAD in sync with .stage padding in styles.css and PAD in electron/main.js.
const PAD = { x: 20, top: 10, bottom: 32 };
const RETRACTED = { w: 190, h: 38 };
const ACTIVE = { w: 640, h: 56 };
const DEFAULT_EXPANDED = { w: 760, h: 600 };
const MIN_EXPANDED = { w: 460, h: 260 };
const SIZE_KEY = "aurora.expanded";
const SETTLE_MS = 650;                   // just beyond the slowest transition in styles.css
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const loadSize = () => {
  try {
    const v = JSON.parse(localStorage.getItem(SIZE_KEY));
    if (v && v.w > 0 && v.h > 0) return v;
  } catch {}
  return DEFAULT_EXPANDED;
};

// Space the island may use: the screen's work area inside the Electron shell, the tab in a browser.
function useRoom() {
  const [room, setRoom] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    if (window.aurora?.workArea) {
      let live = true;
      const ask = () => window.aurora.workArea().then((wa) => live && wa && setRoom({ w: wa.width, h: wa.height })).catch(() => {});
      ask();
      const t = setInterval(ask, 5000);
      return () => { live = false; clearInterval(t); };
    }
    const on = () => setRoom({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return room;
}

const TABS = ["Conversation", "Console", "Controls", "History", "Memory", "Skills", "Tools", "Prompt", "Settings"];

export default function App() {
  const a = useAurora();
  const [mode, setMode] = useState("retracted"); // retracted | active | expanded
  const room = useRoom();
  const [want, setWant] = useState(loadSize); // the expanded size the user prefers (drag the corner grip)
  const [dragging, setDragging] = useState(false);
  const maxW = Math.max(200, room.w - 2 * PAD.x);
  const maxH = Math.max(120, room.h - PAD.top - PAD.bottom);
  const expanded = {
    w: clamp(want.w, Math.min(MIN_EXPANDED.w, maxW), maxW),
    h: clamp(want.h, Math.min(MIN_EXPANDED.h, maxH), maxH),
  };
  const size = mode === "retracted" ? RETRACTED : mode === "active" ? { w: Math.min(ACTIVE.w, maxW), h: ACTIVE.h } : expanded;
  const islandRef = useRef(null);

  // KWin's blur must follow the island, not the transparent shell padding.
  // ResizeObserver reports the intermediate CSS-transition sizes too; reporting
  // only once on a mode change left a small stale blur rectangle behind the
  // growing island until the animation finished.
  useEffect(() => {
    if (!window.aurora?.blurRegion || !islandRef.current) return;
    let frame = 0;
    const sendRegion = () => {
      frame = 0;
      const r = islandRef.current?.getBoundingClientRect();
      if (r) window.aurora.blurRegion(r.left, r.top, r.width, r.height);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(sendRegion);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(islandRef.current);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  // Tell Electron how big the window must be. Grow at once (so the island animates inside a big enough
  // window); shrink only after the CSS transition has finished (so it is not cropped mid-animation).
  // Keeping the grow bounds at the exact target avoids exposing an oversized transparent native shell.
  const winSent = useRef({ w: 0, h: 0 });
  useEffect(() => {
    if (!window.aurora?.resize) return;
    const send = (w, h) => { winSent.current = { w, h }; window.aurora.resize(w + 2 * PAD.x, h + PAD.top + PAD.bottom); };
    const prev = winSent.current;
    const big = { w: Math.max(size.w, prev.w), h: Math.max(size.h, prev.h) };
    if (big.w !== prev.w || big.h !== prev.h) send(big.w, big.h);
    const t = setTimeout(() => send(size.w, size.h), SETTLE_MS);
    return () => clearTimeout(t);
  }, [size.w, size.h]);

  // Track which way each dimension is moving for transition-specific styling.
  const last = useRef(size);
  const dir = useRef({ w: "g", h: "g" });
  if (size.w !== last.current.w) dir.current.w = size.w > last.current.w ? "g" : "s";
  if (size.h !== last.current.h) dir.current.h = size.h > last.current.h ? "g" : "s";
  last.current = size;
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    setMoving(true);
    const t = setTimeout(() => setMoving(false), SETTLE_MS);
    return () => clearTimeout(t);
  }, [size.w, size.h]);

  // corner grip: the island is centred, so the width changes by twice the pointer's travel
  const drag = useRef(null);
  const gripDown = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.screenX, y: e.screenY, ...expandedRef.current };
    setDragging(true);
  };
  const gripMove = (e) => {
    const d = drag.current;
    if (d) setWant({ w: d.w + 2 * (e.screenX - d.x), h: d.h + (e.screenY - d.y) });
  };
  const gripUp = () => {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    const v = expandedRef.current;
    setWant(v);
    try { localStorage.setItem(SIZE_KEY, JSON.stringify(v)); } catch {}
  };
  const gripReset = () => {
    setWant(DEFAULT_EXPANDED);
    try { localStorage.removeItem(SIZE_KEY); } catch {}
  };
  const [tab, setTab] = useState("Conversation");
  const [draft, setDraft] = useState("");
  const input = useRef(null);
  const [ctl, setCtl] = useControls(a.connected);
  const busy = a.status === "Thinking" || a.status === "Working";
  const v = useVoiceInput({ send: a.send, gate: busy || a.speaking, setDraft, onError: a.setError, unlock: a.unlock });
  const shown = !a.connected ? "Error" : a.speaking ? "Speaking" : v.transcribing ? "Transcribing"
    : (v.live || v.recording) && !busy ? "Listening" : a.status;
  const label = !a.connected ? "Backend offline" : shown;

  useEffect(() => { if (mode !== "retracted") input.current?.focus(); }, [mode]);
  useEffect(() => { if (a.reviewTick) { setMode("expanded"); setTab("Console"); } }, [a.reviewTick]);

  // Esc tucks the island away one step (expanded -> bar -> pill -> system tray). It never stops a
  // running reply, speech or script: use the Stop button in the bar for that.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (mode === "expanded") setMode("active");
      else if (mode === "active") setMode("retracted");
      else if (window.aurora?.minimize) window.aurora.minimize();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  // Minimize: hide the window to the system tray (Electron). In a browser tab, fall back to the pill.
  const minimize = () => (window.aurora?.minimize ? window.aurora.minimize() : setMode("retracted"));
  // Coming back from the tray: put the cursor in the box.
  useEffect(() => window.aurora?.onShown?.(() => input.current?.focus()), []);

  const submit = () => {
    if (a.send(draft)) { setDraft(""); if (mode !== "expanded") setMode("expanded"); setTab("Conversation"); }
  };
  const tabBody = useMemo(() => ({
    Conversation: <Conversation a={a} />,
    Console: <Console a={a} onReturned={() => setTab("Conversation")} />,
    Controls: <Controls c={ctl} set={setCtl} />,
    History: <History a={a} onOpen={() => setTab("Conversation")} />,
    Memory: <Memory onError={a.setError} />,
    Skills: <Skills onError={a.setError} />,
    Tools: <Tools onError={a.setError} />,
    Prompt: <Prompt onError={a.setError} />,
    Settings: <Settings a={a} />,
  }), [a, ctl]);

  return (
    <div className="stage">
      <div
        className={`island ${mode} w${dir.current.w} h${dir.current.h}${moving ? " moving" : ""}${dragging ? " dragging" : ""}`}
        ref={islandRef}
        style={{ width: size.w, height: size.h }}
        role="application"
        aria-label="Aurora"
      >

        {mode === "retracted" ? (
          <button className="pill" onClick={() => setMode("active")} aria-label="Open Aurora">
            <Dot status={shown} /><span>{label}</span>
          </button>
        ) : (
          <>
            <div className="bar">
              <button className="icon min" onClick={minimize} title="Minimize to system tray"
                aria-label="Minimize to system tray"><Icon n="min" /></button>
              <div className="status"><Dot status={shown} /><span>{label}</span></div>
              <input ref={input} className="field" placeholder="Ask anything…" value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()} />
              <button className={`icon ${v.live ? "on" : ""}`} onClick={v.toggleLive} disabled={!a.voice.stt}
                title={a.voice.stt ? "Live: hands-free conversation" : (a.voice.stt_error || (a.voice.stt_loading ? "Speech recognition is loading…" : "Speech recognition is unavailable"))}><Icon n="live" /></button>
              <button className={`icon ${v.recording ? "rec" : ""}`} onClick={v.toggleRecord} disabled={!a.voice.stt || v.live}
                title={v.recording ? "Stop recording" : "Record a message"}><Icon n="mic" /></button>
              <button className="icon" disabled title="Camera is coming soon"><Icon n="cam" /></button>
              {(busy || a.speaking)
                ? <button className="icon stop" onClick={a.stop} title="Stop"><Icon n="stop" /></button>
                : <button className="icon send" onClick={submit} disabled={!draft.trim() || !a.connected} title="Send"><Icon n="send" /></button>}
              <button className={`icon auto ${ctl?.auto_exec ? "on" : ""}`} disabled={!ctl}
                onClick={() => setCtl({ auto_exec: !ctl.auto_exec })}
                title={ctl?.auto_exec ? "Auto-run is ON: commands and tools run by themselves (click to turn off)" : "Auto-run is off: you review every command (click to turn on)"}
                aria-pressed={!!ctl?.auto_exec}><Icon n="bolt" /></button>
              <button className={`icon chev ${mode === "expanded" ? "up" : ""}`}
                onClick={() => setMode(mode === "expanded" ? "active" : "expanded")}
                title={mode === "expanded" ? "Collapse" : "Expand"}><Icon n="chev" /></button>
            </div>
            {mode === "expanded" && (
              <div className="panel">
                <nav className="tabs">
                  {TABS.map((t) => (
                    <button key={t} className={t === tab ? "on" : ""} onClick={() => setTab(t)}>
                      {t}{t === "Console" && Object.values(a.runs).some((r) => r.status === "waiting") && <b className="badge" />}
                    </button>
                  ))}
                </nav>
                {a.error && (
                  <div className="error">{a.error}
                    <button onClick={() => a.setError(null)}>Dismiss</button>
                  </div>
                )}
                <div className="body">{tabBody[tab]}</div>
              </div>
            )}
          </>
        )}
        {mode === "expanded" && (
          <div className="grip" title="Drag to resize · double-click to reset" onPointerDown={gripDown}
            onPointerMove={gripMove} onPointerUp={gripUp} onPointerCancel={gripUp} onDoubleClick={gripReset} />
        )}
      </div>
    </div>
  );
}
