# --- voice_streaming.py ---
"""Streams an LLM reply to Piper in natural chunks and hands raw PCM16 audio to a callback.

Changes from the first version:
  * PiperEngine keeps the voice loaded in-process (piper-tts) instead of starting the piper
    command for every chunk, which removes ~0.5-1s of model load per phrase. It falls back to
    the piper command automatically if the Python API isn't usable.
  * Pauses are real silence appended to the audio (the old time.sleep() on the server did not
    create gaps, because audio was already queued on the client).
  * First chunk of a reply is allowed to be short (FIRST_CHUNK_WORDS) so speech starts sooner.
  * The chunker drains everything it can per call and never silently drops buffered text.
  * cancel() stops synthesis immediately (Stop button / interrupt); close() lets it finish.
  * Long replies are no longer cut off after ~10s of backlog.
"""
import asyncio
import json
import logging
import os
import queue
import shutil
import subprocess
import threading

log = logging.getLogger("aurora.tts")

# ---- Config (pauses are seconds of silence appended after a chunk) ----
NORMAL_PAUSE = 0.003
PUNCTUATION_PAUSE = 0.05
COMMA_PAUSE = 0.035
QUESTION_PAUSE = 0.3
MAX_BUFFER_SIZE = 1000
SPEED_RATIO = 0.915          # Piper length-scale; lower = faster
FIRST_CHUNK_WORDS = 5        # the first chunk of a reply may be this short
MIN_CHUNK_SIZE = 10          # later chunks never end before this many words
COMMA_MIN_WORDS = 10         # phrase-boundary splits need this many words
MAX_CHUNK_CHARS = 140        # force a split at the NEXT space beyond this

ABBREVIATIONS = {
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc',
    'eg', 'ie', 'approx', 'no', 'inc', 'ltd', 'co', 'gen', 'rep',
    'sen', 'gov', 'lt', 'col', 'maj', 'capt', 'ave', 'blvd',
}
SENTENCE_END_CHARS = {'.', '!', '?'}
HARD_STOP_CHARS = {':', ';'}
SOFT_BOUNDARY_CHARS = {','}
SPACED_BOUNDARY_CHARS = {'-', '—', '(', ')', '[', ']'}


def _is_real_sentence_end(text, idx):
    """text[idx] is . ! ? - decide if it's a genuine sentence end (not an abbreviation,
    initial, decimal, or mid-ellipsis dot)."""
    ch = text[idx]
    if idx + 1 < len(text) and not text[idx + 1].isspace():
        return False
    if ch == '.':
        start = idx
        while start > 0 and text[start - 1].isalpha():
            start -= 1
        word = text[start:idx].lower()
        if word in ABBREVIATIONS or len(word) == 1:
            return False
    return True


def _is_spaced_boundary(text, idx):
    """Dash/paren chars only count when separated from words by whitespace."""
    ch = text[idx]
    prev_ok = idx == 0 or text[idx - 1].isspace()
    next_ok = idx + 1 >= len(text) or text[idx + 1].isspace()
    if ch in {'(', '['}:
        return prev_ok
    if ch in {')', ']'}:
        return next_ok
    return prev_ok and next_ok


def _pause_for(phrase):
    last = phrase.strip()[-1:] or ''
    if last in {'.', '!', ':'}:
        return PUNCTUATION_PAUSE
    if last in {',', ';'}:
        return COMMA_PAUSE
    if last == '?':
        return QUESTION_PAUSE
    if last in {'-', '—', '(', ')'}:
        return COMMA_PAUSE * 0.4
    return NORMAL_PAUSE


def _read_rate(model_path):
    try:
        with open(str(model_path) + ".json", encoding="utf-8") as f:
            return int(json.load(f)["audio"]["sample_rate"])
    except Exception:
        return 22050


class PiperEngine:
    """Blocking text -> raw PCM16 mono bytes. Use from one worker thread."""

    def __init__(self, model_path, length_scale=SPEED_RATIO, piper_bin=None):
        self.model_path = str(model_path)
        self.length_scale = float(length_scale)
        self.sample_rate = _read_rate(self.model_path)
        self.piper_bin = (piper_bin or os.getenv("PIPER_BIN") or shutil.which("piper")
                          or "/home/kelvin/.local/bin/piper")
        self.voice = None
        self.proc = None
        self.lock = threading.Lock()
        try:
            from piper import PiperVoice
            self.voice = PiperVoice.load(self.model_path)
            log.info("Piper loaded in-process: %s (%d Hz)", self.model_path, self.sample_rate)
        except Exception as e:
            log.info("In-process Piper unavailable (%s); using the piper command", e)

    def synth(self, text):
        with self.lock:
            if self.voice is not None:
                try:
                    return self._synth_inproc(text)
                except Exception as e:
                    log.warning("In-process Piper failed (%s); switching to the piper command", e)
                    self.voice = None
            return self._synth_cli(text)

    def _synth_inproc(self, text):
        v = self.voice
        if hasattr(v, "synthesize_stream_raw"):            # piper-tts 1.2.x
            return b"".join(v.synthesize_stream_raw(text, length_scale=self.length_scale))
        from piper import SynthesisConfig                  # piper-tts 1.3+
        cfg = SynthesisConfig(length_scale=self.length_scale)
        return b"".join(c.audio_int16_bytes for c in v.synthesize(text, syn_config=cfg))

    def _synth_cli(self, text):
        self.proc = subprocess.Popen(
            [self.piper_bin, '--model', self.model_path, '--output_raw', '--length-scale', str(self.length_scale)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        out, _ = self.proc.communicate(text.encode('utf-8'))
        return out if self.proc.returncode == 0 else b""

    def cancel(self):
        p = self.proc
        if p and p.poll() is None:
            try:
                p.kill()
            except Exception:
                pass


class WordStreamingVoice:
    """One instance per reply. send_audio is `async def f(pcm: bytes)`."""

    def __init__(self, engine, send_audio, loop):
        self.engine, self.send_audio, self.loop = engine, send_audio, loop
        self.q = queue.Queue()
        self.buffer = ""
        self.emitted = 0
        self.cancelled = threading.Event()
        self.thread = None

    # ---- lifecycle ----
    def start(self):
        self.thread = threading.Thread(target=self._worker, daemon=True)
        self.thread.start()

    def close(self):
        """No more text is coming: speak what is left, then let the worker finish by itself."""
        self._flush_buffer(force=True)
        self.q.put(None)

    def cancel(self):
        """Stop now: drop queued text, kill running synthesis."""
        self.cancelled.set()
        self.buffer = ""
        try:
            while True:
                self.q.get_nowait()
        except queue.Empty:
            pass
        self.engine.cancel()
        self.q.put(None)

    # ---- chunking ----
    def add_words(self, text):
        """Append a streamed fragment, keeping the source's own spacing (so "do" + "n't" stays one word)."""
        if text and not self.cancelled.is_set():
            self.buffer += text
            self._flush_buffer()

    def _flush_buffer(self, force=False):
        if force:
            if self.buffer.strip():
                self._emit_chunk(self.buffer, len(self.buffer))
            self.buffer = ""
            return
        while self._flush_once():
            pass

    def _flush_once(self):
        text = self.buffer
        if not text.strip():
            return False
        first = self.emitted == 0
        sentence_words = FIRST_CHUNK_WORDS if first else MIN_CHUNK_SIZE
        phrase_words = FIRST_CHUNK_WORDS if first else COMMA_MIN_WORDS

        # 1) real sentence endings and : ;
        for i, ch in enumerate(text):
            if ch in SENTENCE_END_CHARS:
                if not _is_real_sentence_end(text, i):
                    continue
            elif ch not in HARD_STOP_CHARS:
                continue
            if len(text[:i + 1].split()) >= sentence_words:
                self._emit_chunk(text, i + 1)
                return True

        # 2) comma / spaced dash / bracket boundaries
        for i, ch in enumerate(text):
            if ch in SOFT_BOUNDARY_CHARS or (ch in SPACED_BOUNDARY_CHARS and _is_spaced_boundary(text, i)):
                if len(text[:i + 1].split()) >= phrase_words:
                    self._emit_chunk(text, i + 1)
                    return True

        # 3) hard ceiling: snap forward to the next space, never cut a word
        if len(text) > MAX_CHUNK_CHARS:
            split_at = text.find(' ', MAX_CHUNK_CHARS)
            if split_at != -1:
                self._emit_chunk(text, split_at + 1)
                return True
        # 4) safety net: never let the buffer grow without bound
        if len(text) > MAX_BUFFER_SIZE:
            self._emit_chunk(text, len(text))
            return True
        return False

    def _emit_chunk(self, text, end_index):
        chunk = text[:end_index].strip()
        self.buffer = text[end_index:]
        if chunk:
            self.emitted += 1
            self.q.put(chunk)

    # ---- synthesis ----
    def _silence(self, phrase):
        n = int(_pause_for(phrase) * self.engine.sample_rate)
        return b"\x00\x00" * n

    async def _send(self, audio):
        try:
            await self.send_audio(audio)
        except Exception:
            pass

    def _worker(self):
        while True:
            phrase = self.q.get()
            if phrase is None or self.cancelled.is_set():
                break
            try:
                audio = self.engine.synth(phrase)
                if audio and not self.cancelled.is_set():
                    asyncio.run_coroutine_threadsafe(self._send(audio + self._silence(phrase)), self.loop)
            except Exception as e:
                log.error("Voice error: %s", e)
