import { useEffect, useRef, useState } from "react";

/* ---------- playback: raw PCM16 mono chunks from the backend ---------- */
export class Player {
  constructor() { this.ctx = null; this.rate = 22050; this.next = 0; this.sources = new Set(); this.onChange = () => {}; }
  unlock() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === "suspended") this.ctx.resume();
  }
  setRate(r) { this.rate = r; }
  push(buf) {
    if (!this.ctx) return;
    const i16 = new Int16Array(buf, 0, buf.byteLength >> 1);
    const f32 = Float32Array.from(i16, (v) => v / 32768);
    const ab = this.ctx.createBuffer(1, f32.length, this.rate);
    ab.copyToChannel(f32, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = ab;
    src.connect(this.ctx.destination);
    const at = Math.max(this.ctx.currentTime + 0.03, this.next);
    src.start(at);
    this.next = at + ab.duration;
    this.sources.add(src);
    if (this.sources.size === 1) this.onChange(true);
    src.onended = () => { this.sources.delete(src); if (!this.sources.size) this.onChange(false); };
  }
  stop() {
    this.sources.forEach((s) => { s.onended = null; try { s.stop(); } catch {} });
    this.sources.clear();
    this.next = 0;
    this.onChange(false);
  }
}

/* ---------- microphone: 16 kHz PCM16 chunks ---------- */
const WORKLET = `class P extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(2048);this.n=0}
process(i){const c=i[0][0];if(c){for(let k=0;k<c.length;k++){this.b[this.n++]=c[k];if(this.n===2048){this.port.postMessage(this.b.slice());this.n=0}}}return true}}
registerProcessor("pcm",P)`;

class Downsampler {
  constructor(inRate) { this.r = inRate / 16000; this.tail = new Float32Array(0); this.pos = 0; }
  push(x) {
    const a = new Float32Array(this.tail.length + x.length);
    a.set(this.tail); a.set(x, this.tail.length);
    const out = [];
    let p = this.pos;
    while (p + 1 < a.length) {
      const i = Math.floor(p), f = p - i;
      out.push(a[i] * (1 - f) + a[i + 1] * f);
      p += this.r;
    }
    const drop = Math.floor(p);
    this.tail = a.slice(drop);
    this.pos = p - drop;
    return Int16Array.from(out, (v) => Math.max(-1, Math.min(1, v)) * 32767);
  }
}

export async function openMic(onPcm) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Microphone capture is not supported by this browser");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: { ideal: 1 },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  let ctx, src, node, keepAlive;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === "suspended") await ctx.resume();
    if (!ctx.audioWorklet || !window.AudioWorkletNode) {
      throw new Error("AudioWorklet is not available");
    }
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    try { await ctx.audioWorklet.addModule(url); }
    finally { URL.revokeObjectURL(url); }
    src = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, "pcm");
    const down = new Downsampler(ctx.sampleRate);
    node.port.onmessage = (e) => onPcm(down.push(e.data));
    // Input-only worklets can be suspended by Chromium unless they lead to an
    // audible destination. Keep it alive through a muted gain node.
    keepAlive = ctx.createGain();
    keepAlive.gain.value = 0;
    src.connect(node);
    node.connect(keepAlive);
    keepAlive.connect(ctx.destination);
    return {
      stop() {
        stream.getTracks().forEach((t) => t.stop());
        try { node.disconnect(); src.disconnect(); keepAlive.disconnect(); ctx.close(); } catch {}
      },
    };
  } catch (error) {
    stream.getTracks().forEach((t) => t.stop());
    try { node?.disconnect(); src?.disconnect(); keepAlive?.disconnect(); ctx?.close(); } catch {}
    throw error;
  }
}

export function wavBlob(chunks, rate = 16000) {
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const buf = new ArrayBuffer(44 + len * 2);
  const v = new DataView(buf);
  const tag = (o, s) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  tag(0, "RIFF"); v.setUint32(4, 36 + len * 2, true); tag(8, "WAVEfmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, "data"); v.setUint32(40, len * 2, true);
  let o = 44;
  for (const c of chunks) for (const s of c) { v.setInt16(o, s, true); o += 2; }
  return new Blob([buf], { type: "audio/wav" });
}

/* ---------- Live (hands-free) and Record (one-shot) ---------- */
export function useVoiceInput({ send, gate, setDraft, onError, unlock }) {
  const [live, setLive] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const liveRef = useRef(null);
  const recRef = useRef(null);
  const gateRef = useRef(gate); gateRef.current = gate; // mic is ignored while Aurora talks or thinks
  const sendRef = useRef(send); sendRef.current = send;

  const stopLive = (clearDraft = false) => {
    const current = liveRef.current;
    liveRef.current = null;
    current?.mic?.stop();
    if (current?.ws) {
      current.ws.onclose = null;
      current.ws.onerror = null;
      try { current.ws.close(); } catch {}
    }
    setLive(false);
    if (clearDraft) setDraft("");
  };
  useEffect(() => () => { stopLive(); recRef.current?.mic.stop(); }, []);

  const toggleLive = async () => {
    unlock();
    if (liveRef.current) { stopLive(true); return; }
    let ws;
    try {
      ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/live_audio`);
      ws.binaryType = "arraybuffer";
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); }
        catch { onError("Speech service sent an invalid response"); stopLive(); return; }
        if (m.type === "partial") setDraft(m.text);
        else if (m.type === "final" && !gateRef.current) { setDraft(""); sendRef.current(m.text); }
        else if (m.type === "error") { onError(m.text || "Speech recognition is not ready"); stopLive(); }
      };
      ws.onclose = () => {
        if (liveRef.current?.ws === ws) {
          stopLive();
          onError("Live listening connection closed");
        }
      };
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Speech service timed out")), 8000);
        ws.onopen = () => { clearTimeout(timeout); resolve(); };
        ws.onerror = () => { clearTimeout(timeout); reject(new Error("Speech service unavailable")); };
      });
      const mic = await openMic((pcm) => { if (!gateRef.current && ws.readyState === 1) ws.send(pcm.buffer); });
      if (ws.readyState !== WebSocket.OPEN) { mic.stop(); throw new Error("Speech service disconnected"); }
      liveRef.current = { ws, mic };
      setLive(true);
    } catch (err) {
      try { ws?.close(); } catch {}
      stopLive();
      const message = err?.name === "NotAllowedError"
        ? "Microphone permission was denied. Enable it in your system and Electron permissions."
        : err?.name === "NotFoundError"
          ? "No microphone was found. Connect one and try again."
          : err?.message || "Could not start live listening";
      onError(message);
    }
  };

  const toggleRecord = async () => {
    unlock();
    if (recRef.current) {
      const { mic, chunks } = recRef.current;
      recRef.current = null; mic.stop(); setRecording(false); setTranscribing(true);
      try {
        const fd = new FormData();
        fd.append("file", wavBlob(chunks), "rec.wav");
        const r = await fetch("/speech/transcribe", { method: "POST", body: fd });
        if (!r.ok) {
          const body = await r.json().catch(() => ({}));
          throw new Error(body.detail || "Transcription failed");
        }
        const d = await r.json();
        d.text ? setDraft(d.text) : onError("Didn't catch that");
      } catch (err) { onError(err?.message || "Transcription failed"); }
      finally { setTranscribing(false); }
      return;
    }
    try {
      const chunks = [];
      recRef.current = { chunks, mic: await openMic((p) => chunks.push(p)) };
      setRecording(true);
    } catch (err) {
      const message = err?.name === "NotAllowedError"
        ? "Microphone permission was denied. Enable it in your system and Electron permissions."
        : err?.name === "NotFoundError"
          ? "No microphone was found. Connect one and try again."
          : err?.message || "Microphone unavailable";
      onError(message);
    }
  };

  return { live, recording, transcribing, toggleLive, toggleRecord };
}
