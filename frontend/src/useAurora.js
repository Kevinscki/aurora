import { useCallback, useEffect, useRef, useState } from "react";
import { Player } from "./voice";
import { jumpToConsole } from "./prefs";

const j = (url, opts) => fetch(url, opts).then((r) => (r.ok ? r.json() : Promise.reject(r)));
const post = (url, body) =>
  j(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const put = (url, body) =>
  j(url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const del = (url) => j(url, { method: "DELETE" });
export const api = { get: j, post, put, del };

export function useAurora() {
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [error, setError] = useState(null);
  const [messages, setMessages] = useState([]); // {role, content, thinking?}
  const [runs, setRuns] = useState({}); // id -> run
  const [convId, setConvId] = useState(null);
  const [ctxStart, setCtxStart] = useState(null);
  const [reviewTick, setReviewTick] = useState(0); // bumps when a script needs review
  const [speaking, setSpeaking] = useState(false);
  const [voice, setVoice] = useState({ stt: false, tts: false });
  const player = useRef(null);
  if (!player.current) player.current = new Player();
  const ws = useRef(null);
  const convRef = useRef(null);
  convRef.current = convId;

  useEffect(() => {
    let closed = false, timer;
    player.current.onChange = setSpeaking;
    const patchLast = (fn) =>
      setMessages((ms) => (ms.length ? [...ms.slice(0, -1), fn(ms[ms.length - 1])] : ms));

    const handle = (m) => {
      switch (m.type) {
        case "start":
          setConvId(m.conv_id);
          setStatus("Thinking");
          setMessages((ms) => [...ms, { role: "assistant", content: "", thinking: "" }]);
          break;
        case "thinking":
          patchLast((x) => ({ ...x, thinking: (x.thinking || "") + m.text }));
          break;
        case "delta":
          patchLast((x) => ({ ...x, content: x.content + m.text }));
          break;
        case "review":
          setRuns((r) => ({ ...r, [m.run.id]: m.run }));
          if (m.auto) setStatus("Working");
          if (!m.auto || jumpToConsole()) setReviewTick((t) => t + 1); // open the Console (Controls: can be turned off for auto-runs)
          break;
        case "run_result":
          setRuns((r) => ({ ...r, [m.run.id]: m.run }));
          break;
        case "notice":
          setError(m.message);
          break;
        case "learned_skill":
          setStatus(`Learned: ${m.skill.title}`);
          break;
        case "audio_format":
          player.current.setRate(m.sample_rate);
          break;
        case "audio_stop":
          player.current.stop();
          break;
        case "error":
          setError(m.message);
          setStatus("Error");
          break;
        case "done":
          setStatus((s) => (s === "Error" ? s : "Idle"));
          break;
      }
    };

    let retry = 0;
    const open = () => {
      const s = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/aurora`);
      ws.current = s;
      s.binaryType = "arraybuffer";
      s.onopen = () => { retry = 0; j("/voice/status").then(setVoice).catch(() => {}); setConnected(true); setError(null); setStatus((x) => (x === "Error" ? "Idle" : x)); };
      s.onerror = () => setConnected(false);
      s.onclose = () => {
        setConnected(false);
        if (!closed) {
          const delay = Math.min(10000, 800 * 2 ** retry++);
          timer = setTimeout(open, delay);
        }
      };
      s.onmessage = (e) => {
        if (typeof e.data !== "string") return player.current.push(e.data);
        try { handle(JSON.parse(e.data)); }
        catch { setError("Received an invalid message from Aurora"); }
      };
    };
    open();
    return () => { closed = true; clearTimeout(timer); ws.current?.close(); };
  }, []);

  // The speech recognizer is deliberately loaded off the backend's startup
  // path.  Its first status response is therefore normally "not ready".
  // Keep checking until it is available instead of leaving the mic controls
  // disabled for the lifetime of the window.
  useEffect(() => {
    let cancelled = false;
    let timer;
    const refreshVoice = async () => {
      try {
        const next = await j("/voice/status");
        if (cancelled) return;
        setVoice(next);
        timer = setTimeout(refreshVoice, next.stt ? 15000 : 1000);
      } catch {
        if (!cancelled) timer = setTimeout(refreshVoice, 2000);
      }
    };
    refreshVoice();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  const send = useCallback((text) => {
    if (!text.trim() || ws.current?.readyState !== 1) return false;
    player.current.unlock();
    player.current.stop();
    setError(null);
    setCtxStart(null);
    setMessages((ms) => [...ms, { role: "user", content: text }]);
    ws.current.send(JSON.stringify({ type: "chat", text, conv_id: convRef.current }));
    setStatus("Thinking");
    return true;
  }, []);

  const stop = useCallback(() => {
    player.current.stop();
    ws.current?.readyState === 1 && ws.current.send(JSON.stringify({ type: "stop" }));
    setStatus("Idle");
  }, []);

  const runAction = useCallback(async (id, action, comment = "") => {
    if (action === "y") {
      setRuns((r) => ({ ...r, [id]: { ...r[id], status: "running" } }));
      setStatus("Working");
    }
    try {
      const res = await post(`/run/${id}/action`, { action, comment });
      if (action === "c") { navigator.clipboard?.writeText(res.code); return res; }
      setRuns((r) => ({ ...r, [id]: res }));
      return res;
    } catch {
      setError("Could not reach Aurora backend");
    } finally {
      if (action === "y") setStatus("Idle");
    }
  }, []);

  const editRun = useCallback(async (id, code) => {
    const res = await post(`/run/${id}/edit`, { code });
    setRuns((r) => ({ ...r, [id]: res }));
    return res;
  }, []);

  const newChat = useCallback(() => { setMessages([]); setConvId(null); setCtxStart(null); setRuns({}); }, []);
  const history = useCallback((q = "") => j(`/history?q=${encodeURIComponent(q)}`), []);
  const openConv = useCallback(async (id) => {
    const d = await j(`/history/${id}`);
    setMessages(d.messages.map(({ role, content }) => ({ role, content })));
    setConvId(id);
    setCtxStart(d.context_starts_at);
    setRuns({});
  }, []);
  const deleteConv = useCallback(async (id) => {
    await fetch(`/history/${id}`, { method: "DELETE" });
    if (convRef.current === id) newChat();
  }, [newChat]);
  const getSettings = useCallback(() => j("/settings"), []);
  const saveSettings = useCallback((patch) => post("/settings", patch), []);

  const unlock = useCallback(() => player.current.unlock(), []);

  return { speaking, voice, unlock, connected, status, error, setError, messages, runs, convId, ctxStart, reviewTick,
    send, stop, runAction, editRun, newChat, history, openConv, deleteConv, getSettings, saveSettings };
}
