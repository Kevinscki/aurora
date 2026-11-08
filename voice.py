"""Speech-to-text (sherpa-onnx + Silero VAD), live mic session, and the text filter for TTS.
Everything here loads lazily and fails soft: if sherpa-onnx or a model is missing, Aurora
still starts and /voice/status reports what is unavailable."""
import asyncio, io, json, logging, os, wave
from pathlib import Path
from threading import Lock

try:
    import numpy as np
except Exception:  # pragma: no cover
    np = None
try:
    import sherpa_onnx
except Exception:
    sherpa_onnx = None

log = logging.getLogger("aurora.voice")

MODEL_DIR = Path(os.getenv("AURORA_MODELS", "/home/kelvin/projects/ai/model/"))
SAMPLE_RATE = 16000
STT_KIND = os.getenv("SHERPA_KIND", "parakeet_tdt")  # parakeet_tdt | nemo_ctc
PARAKEET_DIR = Path(os.getenv("PARAKEET_DIR", MODEL_DIR / "parakeet"))
SHERPA_MODEL = os.getenv("SHERPA_MODEL", str(MODEL_DIR / "sherpa/model.int8.onnx"))
SHERPA_TOKENS = os.getenv("SHERPA_TOKENS", str(MODEL_DIR / "sherpa/tokens.txt"))
VAD_MODEL = os.getenv("VAD_MODEL", str(MODEL_DIR / "silero_vad.onnx"))
ASR_THREADS = int(os.getenv("ASR_THREADS", "4"))


class SpeechEngine:
    def __init__(self):
        self.recognizer = None
        self.error = ""
        self.loading = True
        self._lock = Lock()

    @property
    def ready(self):
        return self.recognizer is not None

    def load(self):
        """Blocking (a few seconds for Parakeet). Run in a thread."""
        with self._lock:
            if self.ready:
                return
            self.loading, self.error = True, ""
            try:
                if sherpa_onnx is None or np is None:
                    raise RuntimeError("sherpa-onnx or numpy is not installed in Aurora's Python environment")
                if STT_KIND == "parakeet_tdt":
                    d = PARAKEET_DIR
                    files = [d / n for n in ("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt")]
                    missing = [str(p) for p in files if not p.is_file()]
                    if missing:
                        raise FileNotFoundError("Parakeet model file missing: " + ", ".join(missing))
                    self.recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
                        encoder=str(d / "encoder.int8.onnx"), decoder=str(d / "decoder.int8.onnx"),
                        joiner=str(d / "joiner.int8.onnx"), tokens=str(d / "tokens.txt"),
                        num_threads=ASR_THREADS, sample_rate=SAMPLE_RATE, feature_dim=80,
                        decoding_method="greedy_search", model_type="nemo_transducer")
                elif STT_KIND == "nemo_ctc":
                    missing = [p for p in (Path(SHERPA_MODEL), Path(SHERPA_TOKENS)) if not p.is_file()]
                    if missing:
                        raise FileNotFoundError("NeMo model file missing: " + ", ".join(map(str, missing)))
                    self.recognizer = sherpa_onnx.OfflineRecognizer.from_nemo_ctc(
                        model=SHERPA_MODEL, tokens=SHERPA_TOKENS, num_threads=ASR_THREADS, debug=False)
                else:
                    raise ValueError(f"Unknown SHERPA_KIND '{STT_KIND}'")
                log.info("Speech engine loaded (%s)", STT_KIND)
            except Exception as e:
                log.exception("Failed to load speech engine")
                self.recognizer, self.error = None, str(e)[:300]
            finally:
                self.loading = False

    def transcribe(self, samples):
        """Blocking. float32 mono @16kHz in [-1, 1]. Call via a thread."""
        if not self.ready or samples.size == 0:
            return ""
        try:
            stream = self.recognizer.create_stream()
            stream.accept_waveform(SAMPLE_RATE, samples)
            self.recognizer.decode_stream(stream)
            return stream.result.text.strip()
        except Exception:
            log.exception("Transcription error")
            return ""


speech = SpeechEngine()


def pcm16_to_float(b: bytes):
    if len(b) % 2:
        b = b[:-1]
    return np.frombuffer(b, dtype=np.int16).astype(np.float32) / 32768.0


def decode_audio_upload(data: bytes):
    """WAV (any rate/channels, 16-bit) or raw PCM16 @16kHz mono."""
    if data[:4] != b"RIFF":
        return pcm16_to_float(data)
    with wave.open(io.BytesIO(data), "rb") as wf:
        ch, width, rate = wf.getnchannels(), wf.getsampwidth(), wf.getframerate()
        frames = wf.readframes(wf.getnframes())
    if width != 2:
        raise ValueError("Only 16-bit WAV is supported")
    s = pcm16_to_float(frames)
    if ch > 1:
        s = s.reshape(-1, ch).mean(axis=1)
    if rate != SAMPLE_RATE:
        n = int(len(s) * SAMPLE_RATE / rate)
        s = np.interp(np.linspace(0, len(s) - 1, n), np.arange(len(s)), s).astype(np.float32)
    return s


def make_vad(silence_seconds: float = 2.5, max_speech_seconds: float = 45.0):
    if sherpa_onnx is None:
        raise RuntimeError("sherpa-onnx is not installed")
    if not Path(VAD_MODEL).is_file():
        raise FileNotFoundError(f"Silero VAD model is missing: {VAD_MODEL}")
    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = VAD_MODEL
    cfg.silero_vad.threshold = 0.5
    # Give speakers room to hesitate, search for a word, or speak quietly.  The
    # old 0.5 second endpoint made live mode submit mid-sentence.
    cfg.silero_vad.min_silence_duration = silence_seconds
    cfg.silero_vad.min_speech_duration = 0.25
    cfg.silero_vad.max_speech_duration = max_speech_seconds
    cfg.silero_vad.window_size = 512
    cfg.sample_rate = SAMPLE_RATE
    cfg.num_threads = 1
    # The ring buffer must be able to hold the whole allowed utterance plus its
    # trailing silence; otherwise a long, valid sentence can be clipped first.
    buffer_seconds = max(30.0, max_speech_seconds + silence_seconds + 5.0)
    return sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=buffer_seconds)


async def run_live(ws, silence_seconds: float = 2.5, max_speech_seconds: float = 45.0):
    """/ws/live_audio: raw PCM16 mono @16kHz in; {"type": "speech"|"final"|"error"} out.
    Silero VAD cuts speech segments, each finished segment is transcribed once."""
    await ws.accept()
    if not speech.ready:
        await ws.send_text(json.dumps({"type": "error", "text": speech.error or "Speech engine not ready"}))
        await ws.close(code=1011)
        return
    try:
        vad = make_vad(silence_seconds, max_speech_seconds)
    except Exception as e:
        log.exception("VAD init failed")
        await ws.send_text(json.dumps({"type": "error", "text": f"VAD init failed: {e}"}))
        await ws.close(code=1011)
        return

    pending, speaking, window = np.zeros(0, dtype=np.float32), False, 512
    try:
        while True:
            samples = pcm16_to_float(await ws.receive_bytes())
            if samples.size == 0:
                continue
            pending = np.concatenate([pending, samples])
            while pending.size >= window:
                vad.accept_waveform(pending[:window])
                pending = pending[window:]
            now = vad.is_speech_detected()
            if now != speaking:
                speaking = now
                await ws.send_text(json.dumps({"type": "speech", "active": speaking}))
            while not vad.empty():
                seg = np.array(vad.front.samples, dtype=np.float32)
                vad.pop()
                text = await asyncio.to_thread(speech.transcribe, seg)
                if text:
                    log.info("Live final: %s", text)
                    await ws.send_text(json.dumps({"type": "final", "text": text}))
    except Exception as e:  # WebSocketDisconnect included
        if type(e).__name__ != "WebSocketDisconnect":
            log.exception("live_audio error")
            try:
                await ws.send_text(json.dumps({"type": "error", "text": "Live speech processing failed. Please try again."}))
            except Exception:
                pass


class TTSFilter:
    """Stateful filter for streamed text going to TTS: drops fenced code blocks (any language,
    including ```remember), handles fences split across chunks, strips markdown noise."""
    FENCE = "```"

    def __init__(self, announce: str = ""):
        self.in_code, self.buf, self.announce = False, "", announce

    @staticmethod
    def _clean(t: str) -> str:
        return (t.replace("*", "").replace("`", "").replace("#", "")
                 .replace("/", " slash ").replace("\\", " backslash "))

    def feed(self, chunk: str) -> str:
        self.buf += chunk
        out = []
        while (i := self.buf.find(self.FENCE)) != -1:
            before, self.buf = self.buf[:i], self.buf[i + 3:]
            if not self.in_code:
                out.append(before)
                self.in_code = True
                if self.announce:
                    out.append(f" {self.announce} ")
            else:
                self.in_code = False
        keep = next((n for n in (2, 1) if self.buf.endswith("`" * n)), 0)
        safe, self.buf = (self.buf[:-keep], self.buf[-keep:]) if keep else (self.buf, "")
        if not self.in_code:
            out.append(safe)
        return self._clean("".join(out))

    def flush(self) -> str:
        tail, self.buf = self.buf, ""
        return "" if self.in_code else self._clean(tail)
