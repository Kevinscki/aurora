import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./useAurora";
import { DEFAULT_OPACITY, MIN_OPACITY, applyOpacity, getOpacity, jumpToConsole, saveOpacity, setJumpToConsole } from "./prefs";

/* Quick controls: auto-run switches and sampling. The state lives in App (one copy) so the bar's Auto
   button and the Controls tab always agree. Every change is saved to the backend straight away. */

const KEYS = ["auto_exec", "auto_tools", "auto_python", "auto_bash", "auto_safe_only", "max_agent_steps", "temperature", "top_p"];
const DEFAULTS = { temperature: 0.7, top_p: 0.95 };

export function useControls(connected) {
  const [c, setC] = useState(null);
  const timers = useRef({});
  useEffect(() => {
    if (!connected) return;
    api.get("/settings").then((s) => setC(Object.fromEntries(KEYS.map((k) => [k, s[k]])))).catch(() => {});
  }, [connected]);
  // delay > 0 for sliders: wait until the user stops dragging
  const set = useCallback((patch, delay = 0) => {
    setC((p) => ({ ...p, ...patch }));
    const id = Object.keys(patch).join();
    clearTimeout(timers.current[id]);
    timers.current[id] = setTimeout(() => api.post("/settings", patch).catch(() => {}), delay);
  }, []);
  return [c, set];
}

function Slider({ label, hint, k, min, max, step, c, set }) {
  const v = c[k];
  const auto = v === null;
  return (
    <label className="slider">
      <span className="srow">
        <span>{label}</span>
        <span className="val">{auto ? "server default" : v.toFixed(2)}</span>
      </span>
      <input type="range" min={min} max={max} step={step} disabled={auto} value={auto ? DEFAULTS[k] : v}
        onChange={(e) => set({ [k]: Number(e.target.value) }, 350)} />
      <span className="hint">{hint}</span>
      <span className="check inline">
        <input type="checkbox" id={`def-${k}`} checked={auto} onChange={(e) => set({ [k]: e.target.checked ? null : DEFAULTS[k] })} />
        <label htmlFor={`def-${k}`}>Use the server's default</label>
      </span>
    </label>
  );
}

export function Controls({ c, set }) {
  const [jump, setJump] = useState(jumpToConsole);
  const [opacity, setOpacityState] = useState(getOpacity);
  const changeOpacity = (v) => { setOpacityState(v); applyOpacity(v); saveOpacity(v); };
  if (!c) return <div className="empty">Loading controls…</div>;
  const off = !c.auto_exec;
  const kind = (k, label) => (
    <label className="check" key={k}>
      <input type="checkbox" disabled={off} checked={c[k]} onChange={(e) => set({ [k]: e.target.checked })} />{label}
    </label>
  );
  return (
    <div className="controls">
      <h4>Auto-run</h4>
      <label className="check big">
        <input type="checkbox" checked={c.auto_exec} onChange={(e) => set({ auto_exec: e.target.checked })} />
        Run commands and tool calls automatically, and send the output back to Aurora
      </label>
      <div className={`kinds ${off ? "disabled" : ""}`}>
        {kind("auto_tools", "Tools (MCP)")}
        {kind("auto_python", "Python")}
        {kind("auto_bash", "Bash")}
      </div>
      <label className="check">
        <input type="checkbox" disabled={off} checked={c.auto_safe_only} onChange={(e) => set({ auto_safe_only: e.target.checked })} />
        Hold dangerous Bash/Python for my review (sudo, rm -r, disk writes, file deletion, …)
      </label>
      <label className="num">Automatic follow-up steps per message
        <input type="number" min="1" max="30" disabled={off} value={c.max_agent_steps}
          onChange={(e) => set({ max_agent_steps: Number(e.target.value) }, 400)} />
      </label>
      <label className="check">
        <input type="checkbox" checked={jump} onChange={(e) => {
          setJump(e.target.checked);
          setJumpToConsole(e.target.checked);
        }} />
        Switch to the Console tab when something runs (also in auto mode)
      </label>
      {c.auto_exec && !c.auto_safe_only && (
        <p className="meta bad">Nothing is held back: dangerous-looking Bash/Python will run immediately. MCP tools always auto-run when Tools is enabled.</p>
      )}

      <h4>Sampling</h4>
      <Slider c={c} set={set} k="temperature" label="Temperature" min={0} max={2} step={0.05}
        hint="Lower is focused and repeatable, higher is more varied and creative." />
      <Slider c={c} set={set} k="top_p" label="Top-p (cutoff probability)" min={0.05} max={1} step={0.01}
        hint="Only the most likely words whose probabilities add up to this are considered. Lower is safer." />

      <h4>Appearance</h4>
      <label className="slider">
        <span className="srow"><span>Window transparency</span><span className="val">{Math.round(opacity * 100)}% opaque</span></span>
        <input type="range" min={MIN_OPACITY} max="1" step="0.01" value={opacity}
          onChange={(e) => changeOpacity(Number(e.target.value))} />
        <span className="hint">Lower lets the desktop show through Aurora. 100% is solid.</span>
        <span className="check inline">
          <button type="button" className="btn" onClick={() => changeOpacity(DEFAULT_OPACITY)}>Reset</button>
        </span>
      </label>
    </div>
  );
}
