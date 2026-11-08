"""Aurora backend. Run: uvicorn backend:app --host 127.0.0.1 --port 8765
Deps: pip install fastapi uvicorn httpx
"""
import asyncio, ipaddress, json, os, re, sqlite3, stat, tempfile, time, uuid
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

import voice as vc
from mcp_client import McpError, McpHub
from voice_streaming import PiperEngine, WordStreamingVoice

CFG = {
    "llm_url": os.getenv("LLM_URL") or os.getenv("OLLAMA_URL") or "http://127.0.0.1:8080",  # llama-server default port
    "api_key": "",  # Bearer token for hosted endpoints (OpenAI, OpenRouter, Groq, ...). Never sent to the UI.
    "llm_api": os.getenv("LLM_API", "openai"),  # openai = llama.cpp / any OpenAI-style server, ollama = Ollama
    "model": os.getenv("AURORA_MODEL") or os.getenv("MODEL_NAME") or "",  # optional for llama.cpp
    "max_messages": 20,
    "max_tokens": 6000,
    "think": "auto",  # off | auto | on
    "code_exec": True,
    "auto_exec": True,        # master switch: run commands/tools without a click and feed the output back to the model
    "auto_tools": True,       #   ...for MCP tool calls
    "auto_python": True,      #   ...for ```python blocks
    "auto_bash": True,        #   ...for ```bash / ```sh blocks
    "auto_safe_only": True,   # hold only Bash/Python scripts that match the language-specific risk patterns below
    "temperature": 0.7,       # None = let the server decide
    "top_p": 0.95,            # nucleus sampling cutoff; None = let the server decide
    "max_agent_steps": 6,     # automatic follow-up replies after auto-run results, per message
    "tool_timeout": 340,      # seconds an MCP tool call may take
    "tts_enabled": True,
    "tts_model": os.getenv("TTS_MODEL_PATH", str(vc.MODEL_DIR / "en_US-libritts_r-medium.onnx")),
    "tts_speed": 0.915,
    "stt_silence_seconds": 2.5,  # pause required before live speech is submitted
    "stt_max_speech_seconds": 45.0,
    "learn_skills": True,        # allow validated ```skill records from the model
    "timeout": 100,
    "output_cap": 20000,
}

# Auto-run is intentionally permissive for MCP tools. Only literal Bash/Python
# source is screened, line by line, for operations that can delete data,
# rewrite disks, elevate privileges, stop the machine, or kill processes.
BASH_RISK = [
    r"\brm\b[^\n]*(?:-[a-zA-Z]*r[a-zA-Z]*|--recursive)\b",
    r"\bsudo\b",
    r"\b(?:mkfs(?:\.[a-z0-9]+)?|wipefs|fdisk|sfdisk|parted|cryptsetup)\b",
    r"\bdd\b[^\n]*(?:\bif=|\bof=)",
    r"\b(?:curl|wget)\b[^|\n]*\|\s*(?:ba)?sh\b",
    r"\bchmod\b[^\n]*-R[^\n]*(?:777|a\+rwx)",
    r"\bchown\b[^\n]*-R[^\n]+\s/(?:\s|$)",
    r":\(\)\s*\{",
    r">\s*/dev/(?:sd[a-z]|nvme\d+n\d+|vd[a-z])",
    r"\b(?:shutdown|reboot|poweroff|halt)\b",
    r"\b(?:pkill|killall)\b",
    r"\bkill\b[^\n]*(?:-9|-KILL)\b",
    r"\bsystemctl\b[^\n]*\b(?:disable|mask|stop)\b",
    r"\b(?:iptables|nft)\b[^\n]*\b(?:-F|flush)\b",
    r"\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f[a-zA-Z]*)",
]
PYTHON_RISK = BASH_RISK + [
    r"\bshutil\.rmtree\s*\(",
    r"\bos\.(?:remove|unlink|rmdir|removedirs|kill|killpg|chown)\s*\(",
    r"(?:\.|\bPath\([^\n]*\)\.)\s*(?:unlink|rmdir)\s*\(",
]
DATA = Path.home() / ".local/share/aurora"
DATA.mkdir(parents=True, exist_ok=True)
db = sqlite3.connect(DATA / "history.db", check_same_thread=False)
db.executescript("""
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, created REAL, title TEXT);
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id TEXT, role TEXT, content TEXT, ts REAL);
""")
app = FastAPI(title="Aurora")

# ---------- config files, system prompt, memory ----------
CONF = Path.home() / ".config/aurora"
CONF.mkdir(parents=True, exist_ok=True)
SETTINGS, SKILLS, MCP = CONF / "settings.json", CONF / "skills.json", CONF / "mcp.json"
hub = McpHub()  # MCP servers from mcp.json
SYSTEM = ("You are Aurora, a desktop assistant. To act, reply with a fenced ```bash or ```python block; "
          "it runs automatically unless it contains a dangerous Bash or Python operation.")

def jload(path, default):
    try:
        return json.loads(path.read_text())
    except Exception:
        return default

def _default_prompt():
    f = os.getenv("AURORA_PROMPT_FILE", "/home/kelvin/projects/ai/markdowns/BASH_ROAST.md")
    try:
        return Path(f).read_text(encoding="utf-8").strip() or SYSTEM
    except Exception:
        return SYSTEM

DEFAULT_PROMPT = _default_prompt()
CFG["system_prompt"] = DEFAULT_PROMPT
ENV_KEY = os.getenv("LLM_API_KEY") or os.getenv("OPENAI_API_KEY") or ""
_saved = jload(SETTINGS, {})
CFG.update({k: v for k, v in _saved.items() if k in CFG})
if "exec_mode" in _saved and "auto_exec" not in _saved:  # settings written by the previous version
    CFG.update(auto_exec=_saved["exec_mode"] in ("auto_safe", "auto"), auto_safe_only=_saved["exec_mode"] != "auto")
if not CFG["api_key"]:
    CFG["api_key"] = ENV_KEY
if CFG["system_prompt"] == SYSTEM:  # never customised: follow the prompt file
    CFG["system_prompt"] = DEFAULT_PROMPT
db.execute("CREATE TABLE IF NOT EXISTS memories(id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT, ts REAL)")
db.commit()

AUTOMEM = ("If the user tells you something lasting about themselves, or asks you to remember something, "
           "save it by adding a fenced ```remember block with one short fact per line. It is saved silently.")
AUTOSKILL = ("When you learn a durable, reusable procedure that would improve future requests and no existing "
             "skill already covers it, you may add it with one fenced ```skill block containing JSON with "
             'exactly a short "title" and a concrete "description". Do not create skills for one-off facts, '
             "preferences, guesses, or capabilities you do not actually have. Create at most one per reply.")

def system_text():
    base = CFG["system_prompt"] or DEFAULT_PROMPT
    parts = [base, AUTOMEM]
    if CFG["learn_skills"]:
        parts.append(AUTOSKILL)
    mem = [r[0] for r in db.execute("SELECT text FROM memories ORDER BY id")]
    if mem:
        parts.append("Things you remember about the user:\n- " + "\n- ".join(mem))
    if tools := hub.prompt_block():
        parts.append(tools)
    skills = [x for x in jload(SKILLS, []) if x.get("title", "").strip()]
    if skills:
        parts.append("Your skills (use them when a request matches):\n" +
                     "\n".join(f"- {x['title'].strip()}: {x.get('description', '').strip()}" for x in skills))
    return "\n\n".join(parts)

# ---------- history ----------
def new_conv(first: str) -> str:
    cid = uuid.uuid4().hex[:12]
    db.execute("INSERT INTO conversations VALUES(?,?,?)", (cid, time.time(), first[:80]))
    db.commit()
    return cid

def add_msg(cid, role, content):
    db.execute("INSERT INTO messages(conv_id,role,content,ts) VALUES(?,?,?,?)", (cid, role, content, time.time()))
    db.commit()

def context(cid):
    """Last N messages, then trimmed to the token budget (~4 chars/token). Whichever is smaller wins."""
    rows = db.execute("SELECT role,content FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT ?",
                      (cid, CFG["max_messages"])).fetchall()
    out, used = [], 0
    for role, content in rows:
        t = len(content) // 4 + 4
        if used + t > CFG["max_tokens"] and out:
            break
        out.append({"role": "user" if role == "code" else role, "content": content}); used += t
    return out[::-1]

def merge_roles(msgs):
    """Join neighbouring messages from the same role. Many chat templates reject two user turns in a row,
    which happens after command output (sent as a user turn) is followed by another message."""
    out = []
    for m in msgs:
        if out and out[-1]["role"] == m["role"]:
            out[-1] = {"role": m["role"], "content": out[-1]["content"] + "\n\n" + m["content"]}
        else:
            out.append(dict(m))
    return out

@app.get("/history")
def history(q: str = ""):
    if q:
        rows = db.execute("""SELECT DISTINCT c.id,c.created,c.title FROM conversations c
            LEFT JOIN messages m ON m.conv_id=c.id WHERE c.title LIKE ? OR m.content LIKE ?
            ORDER BY c.created DESC""", (f"%{q}%", f"%{q}%")).fetchall()
    else:
        rows = db.execute("SELECT id,created,title FROM conversations ORDER BY created DESC").fetchall()
    return [{"id": r[0], "created": r[1], "title": r[2]} for r in rows]

@app.get("/history/{cid}")
def history_get(cid: str):
    rows = db.execute("SELECT role,content,ts FROM messages WHERE conv_id=? ORDER BY id", (cid,)).fetchall()
    cut = max(0, len(rows) - len(context(cid)))
    ctx_start = sum(1 for r in rows[:cut] if r[0] != "code")  # index among the visible messages
    return {"id": cid, "messages": [{"role": r, "content": c, "ts": t} for r, c, t in rows if r != "code"],
            "context_starts_at": ctx_start}  # UI draws the "outside context" marker here

@app.delete("/history/{cid}")
def history_del(cid: str):
    db.execute("DELETE FROM messages WHERE conv_id=?", (cid,))
    db.execute("DELETE FROM conversations WHERE id=?", (cid,))
    db.commit()
    return {"ok": True}

# ---------- runner ----------
RUNS: dict[str, dict] = {}
INTERP = {"bash": ["bash"], "sh": ["bash"], "python": ["python3"], "py": ["python3"]}

def risk_check(code: str, lang: str):
    """Return source line numbers that require review. MCP tool calls are always trusted for auto-run."""
    lang = lang.lower()
    if lang == "tool":
        return []
    patterns = PYTHON_RISK if lang in ("python", "py") else BASH_RISK
    hits = []
    for i, line in enumerate(code.splitlines(), 1):
        if any(re.search(p, line, re.I) for p in patterns):
            hits.append(i)
    return hits

def register_run(lang: str, code: str, conv_id: str | None = None) -> dict:
    return public(_register(lang, code, conv_id))

def _register(lang: str, code: str, conv_id: str | None = None, readonly: bool = False, destructive: bool = False) -> dict:
    lang = lang.lower()
    path = None
    if lang != "tool":
        if lang not in INTERP:
            raise HTTPException(400, f"Unsupported language: {lang}")
        fd, path = tempfile.mkstemp(prefix="aurora_", suffix=".sh" if "sh" in lang else ".py")
        with os.fdopen(fd, "w") as f:
            f.write(code)
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)  # private
    rid = uuid.uuid4().hex[:10]
    RUNS[rid] = {"id": rid, "lang": lang, "path": path, "code": code, "status": "waiting",
                 "risky_lines": risk_check(code, lang), "proc": None, "task": None, "orig": code,
                 "conv_id": conv_id, "readonly": readonly, "destructive": destructive}
    return RUNS[rid]

def register_tool_run(code: str, conv_id: str | None) -> dict:
    """Validate a ```tool block from the model and register it. Raises ValueError / McpError with a message
    the model can act on."""
    try:
        call = json.loads(code)
    except ValueError as e:
        raise ValueError(f'The tool block is not valid JSON ({e}). Use {{"server": ..., "tool": ..., "arguments": {{...}}}}.')
    if not isinstance(call, dict):
        raise ValueError("The tool block must be a JSON object.")
    t = hub.resolve(call.get("server"), call.get("tool"))
    args = call.get("arguments", call.get("args", {})) or {}
    if not isinstance(args, dict):
        raise ValueError('"arguments" must be a JSON object.')
    pretty = json.dumps({"server": t["server"], "tool": t["name"], "arguments": args}, indent=2, ensure_ascii=False)
    return _register("tool", pretty, conv_id, readonly=t["readonly"], destructive=t["destructive"])

def public(r):
    return {k: v for k, v in r.items() if k not in ("proc", "task", "path", "conv_id")}

def format_run_result(r):
    out = r.get("output") or "(empty)"
    if len(out) > 3000:
        out = out[:1000] + "\n[... truncated ...]\n" + out[-2000:]
    limit = CFG["tool_timeout"] if r["lang"] == "tool" else CFG["timeout"]
    status = {"timeout": f"TIMED OUT after {limit}s", "aborted": "stopped by the user"}.get(
        r["status"], f"exit code {r.get('exit_code')}")
    what, noun = ("tool output", "tool call") if r["lang"] == "tool" else ("code execution output", "script")
    how = "was run automatically" if r.get("auto") else "was approved and run"
    head = (f"[Automated {what} — not typed by the user. The {noun} you proposed {how}"
            + ("" if r["lang"] == "tool" else " on the user's machine")
            + (" after they edited it" if r.get("edited") else "") + ". Use this in your next reply.]")
    code = f"\n{noun.capitalize()} that ran:\n{r['code']}\n" if r.get("edited") else ""
    return f"{head}{code}\n--- {r['lang']} - {status} ---\n{out}"

class ReviewIn(BaseModel):
    lang: str
    code: str

class ActionIn(BaseModel):
    action: str  # y n c r ab
    comment: str = ""

class EditIn(BaseModel):
    code: str

@app.post("/run/review")
def run_review(b: ReviewIn):
    if not CFG["code_exec"]:
        raise HTTPException(403, "Code execution is off")
    return register_run(b.lang, b.code)

async def execute(r):
    r["status"] = "running"; t0 = time.time()
    if r["lang"] == "tool":
        return await execute_tool(r, t0)
    proc = await asyncio.create_subprocess_exec(
        *INTERP[r["lang"]], r["path"], stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        stdin=asyncio.subprocess.DEVNULL, start_new_session=True)
    r["proc"] = proc
    buf = b""
    async def read():
        nonlocal buf
        while chunk := await proc.stdout.read(4096):
            if len(buf) < CFG["output_cap"]:
                buf += chunk
    try:
        await asyncio.wait_for(asyncio.gather(read(), proc.wait()), CFG["timeout"])
        r["status"] = "done"
    except asyncio.TimeoutError:
        kill(proc); r["status"] = "timeout"
    except asyncio.CancelledError:  # the chat turn was interrupted: don't leave the script running
        kill(proc); r["status"] = "aborted"; cleanup(r)
        raise
    if r.get("aborted"):
        r["status"] = "aborted"
    r.update(exit_code=proc.returncode, duration=round(time.time() - t0, 2),
             output=buf[:CFG["output_cap"]].decode(errors="replace"),
             truncated=len(buf) >= CFG["output_cap"])
    cleanup(r)

async def execute_tool(r, t0):
    """Run one MCP tool call. It runs as its own task so the Stop button can cancel just this call."""
    call = json.loads(r["code"])  # validated when it was registered; re-read because the user may have edited it
    task = asyncio.ensure_future(hub.call(call.get("server"), call.get("tool"), call.get("arguments") or {},
                                          CFG["tool_timeout"]))
    r["task"] = task
    try:
        await asyncio.wait({task})
    except asyncio.CancelledError:
        task.cancel(); r["status"] = "aborted"
        raise
    status, code = "done", 0
    if task.cancelled():
        text, status, code = "Stopped by the user", "aborted", 1
    elif exc := task.exception():
        text, code = (str(exc) or type(exc).__name__), 1
        if isinstance(exc, asyncio.TimeoutError):
            status = "timeout"
    else:
        text, is_err = task.result()
        code = 1 if is_err else 0
    r.update(status=status, exit_code=code, duration=round(time.time() - t0, 2),
             output=text[:CFG["output_cap"]], truncated=len(text) > CFG["output_cap"])

def cleanup(r):
    if r.get("path") and os.path.exists(r["path"]):
        os.unlink(r["path"])

def kill(proc):
    try:
        os.killpg(proc.pid, 9)
    except ProcessLookupError:
        pass

def abort(r):
    """Stop a running script or tool call."""
    r["aborted"] = True
    if r.get("task"):
        r["task"].cancel()
    elif r.get("proc"):
        kill(r["proc"])

@app.post("/run/{rid}/edit")
def run_edit(rid: str, b: EditIn):
    r = RUNS.get(rid)
    if not r or r["status"] != "waiting":
        raise HTTPException(409, "This script can no longer be edited")
    if r["lang"] == "tool":
        try:
            call = json.loads(b.code)
            assert isinstance(call, dict) and isinstance(call.get("arguments", {}), dict)
        except Exception:
            raise HTTPException(400, "A tool call must be a JSON object with server, tool and arguments")
    else:
        Path(r["path"]).write_text(b.code)
    r.update(code=b.code, risky_lines=risk_check(b.code, r["lang"]), edited=True)
    return public(r)

@app.post("/run/{rid}/action")
async def run_action(rid: str, b: ActionIn):
    r = RUNS.get(rid)
    if not r:
        raise HTTPException(404, "Unknown run")
    a = b.action
    if a == "y" and r["status"] == "waiting":
        await execute(r)
        if r.get("conv_id"):
            add_msg(r["conv_id"], "code", format_run_result(r))  # model sees it on the next user message
    elif a == "n":
        r["status"] = "rejected"
    elif a == "ab" and r["status"] == "running":
        abort(r)
    elif a == "c":   # assumption: c = copy; UI puts r["code"] on the clipboard
        return {"code": r["code"]}
    elif a == "r":   # assumption: r = send back to the model for revision (UI handles it)
        r["status"] = "revise"; r["comment"] = b.comment
    elif a == "t":
        raise HTTPException(501, "Interactive PTY is milestone 10")
    return public(r)

AUTO_KEY = {"tool": "auto_tools", "python": "auto_python", "bash": "auto_bash"}

def run_kind(r) -> str:
    if r["lang"] == "tool":
        return "tool"
    return "python" if INTERP[r["lang"]][0].startswith("python") else "bash"

def should_auto(r) -> bool:
    """Does this run start without waiting for the user's click?"""
    if not CFG["auto_exec"] or not CFG[AUTO_KEY[run_kind(r)]]:
        return False
    # MCP annotations are hints, not an approval gate in Aurora's autonomous mode.
    # The review gate applies only to source code matched by the Bash/Python rules.
    if CFG["auto_safe_only"] and r["lang"] != "tool" and r["risky_lines"]:
        return False
    return True

# ---------- chat ----------
FENCE = re.compile(r"```(\w+)\n(.*?)```", re.S)
CODEY = re.compile(r"\b(code|script|bug|function|python|bash|refactor|error|compile)\b", re.I)

def want_think(text: str):
    m = CFG["think"]
    return True if m == "on" else (bool(CODEY.search(text)) if m == "auto" else False)

def save_memories(block: str) -> list[str]:
    have = {r[0].lower() for r in db.execute("SELECT text FROM memories")}
    saved = []
    for line in block.splitlines()[:5]:
        t = line.strip().lstrip("-• ").strip()[:200]
        if t and t.lower() not in have:
            db.execute("INSERT INTO memories(text,ts) VALUES(?,?)", (t, time.time()))
            have.add(t.lower()); saved.append(t)
    db.commit()
    return saved

def save_skill(block: str) -> dict | None:
    """Validate and persist one model-authored prompt skill when it is genuinely new."""
    try:
        item = json.loads(block)
    except (TypeError, json.JSONDecodeError):
        return None
    if not isinstance(item, dict):
        return None
    title = " ".join(str(item.get("title", "")).split())[:80]
    description = " ".join(str(item.get("description", "")).split())[:600]
    if not title or not description:
        return None
    items = jload(SKILLS, [])
    if not isinstance(items, list):
        items = []
    key = title.casefold()
    if any(str(existing.get("title", "")).strip().casefold() == key for existing in items
           if isinstance(existing, dict)):
        return None
    learned = {"id": uuid.uuid4().hex[:8], "title": title, "description": description}
    items.append(learned)
    SKILLS.write_text(json.dumps(items[-100:], indent=2))
    return learned

_tts = {"path": None, "engine": None}

async def get_tts():
    """The loaded Piper voice, or None if speech is off or the model file is missing."""
    path = CFG["tts_model"]
    if not CFG["tts_enabled"] or not Path(path).exists():
        return None
    if _tts["engine"] is None or _tts["path"] != path:
        try:
            _tts["engine"] = await asyncio.to_thread(PiperEngine, path, CFG["tts_speed"])
            _tts["path"] = path
        except Exception:
            _tts["engine"] = None
            return None
    _tts["engine"].length_scale = float(CFG["tts_speed"])
    return _tts["engine"]

def is_local(url: str) -> bool:
    """True for localhost / LAN servers (llama.cpp, Ollama). Hosted APIs reject llama.cpp-only request fields."""
    host = (urlparse(url if "://" in url else "http://" + url).hostname or "").lower()
    if host in ("localhost", "") or host.endswith(".local") or host.endswith(".lan"):
        return True
    try:
        ip = ipaddress.ip_address(host)
        return ip.is_private or ip.is_loopback
    except ValueError:
        return False

def openai_url(base: str, tail: str) -> str:
    """Build .../chat/completions or .../models from whatever the user typed:
    http://127.0.0.1:8080 | https://api.openai.com/v1 | https://openrouter.ai/api/v1 |
    https://generativelanguage.googleapis.com/v1beta/openai | a full .../chat/completions URL."""
    base = base.strip().rstrip("/")
    u = urlparse(base if "://" in base else "https://" + base)
    if u.hostname == "api.groq.com" and u.path in ("", "/"):  # Groq's OpenAI API lives under /openai/v1
        base = f"{u.scheme}://{u.netloc}/openai/v1"
    if base.endswith("/chat/completions"):
        return base if tail == "chat/completions" else base[: -len("chat/completions")] + tail
    if re.search(r"/v\d+[a-z0-9]*(/openai)?$", base) or base.endswith("/openai"):
        return f"{base}/{tail}"
    return f"{base}/v1/{tail}"

def clean_key(k) -> str:
    return re.sub(r"\s+", "", str(k or "")).strip("\"'")

def auth_headers(key: str | None = None) -> dict:
    key = clean_key(CFG["api_key"] if key is None else key)
    return {"Authorization": f"Bearer {key}"} if key else {}

def api_message(resp) -> str:
    """The server's own error text (Groq/OpenAI/OpenRouter send {"error": {"message": ...}}), if it can be read."""
    try:
        d = resp.json()
        e = d.get("error", d) if isinstance(d, dict) else d
        m = e.get("message") if isinstance(e, dict) else e
        return str(m or "")[:300]
    except Exception:
        try:
            return resp.text.strip()[:200]
        except Exception:
            return ""

def explain(resp) -> str:
    """Status + hint + what the server said + the exact URL that was called."""
    code = resp.status_code
    msg = api_message(resp)
    return f"{code}{http_hint(code)}" + (f". Server says: {msg}" if msg else "") + f". Called: {resp.request.url}"

def http_hint(code: int) -> str:
    return {401: " (the API key was rejected: check it in Settings)", 403: " (access denied for this API key)",
            404: " (wrong server address or model name)", 429: " (rate limited or out of credit)"}.get(code, "")

def sampling() -> dict:
    """Temperature / top_p when set; left out entirely when None so the server uses its own defaults."""
    vals = {k: CFG[k] for k in ("temperature", "top_p") if CFG[k] is not None}
    return vals

async def llm_stream(messages, think: bool):
    """Yields ("thinking" | "content", text) from llama.cpp / OpenAI-style servers or Ollama."""
    base = CFG["llm_url"].rstrip("/")
    async with httpx.AsyncClient(timeout=None, headers=auth_headers()) as c:
        if CFG["llm_api"] == "ollama":
            body = {"model": CFG["model"], "stream": True, "think": think, "messages": messages}
            if opts := sampling():
                body["options"] = opts
            async with c.stream("POST", f"{base}/api/chat", json=body) as resp:
                if resp.is_error:
                    await resp.aread()
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    m = json.loads(line).get("message", {})
                    if m.get("thinking"):
                        yield "thinking", m["thinking"]
                    if m.get("content"):
                        yield "content", m["content"]
            return
        body = {"stream": True, "messages": messages, **sampling()}
        if is_local(base):  # llama.cpp understands this; OpenAI & co. answer 400 to unknown fields
            body["chat_template_kwargs"] = {"enable_thinking": think}
        if CFG["model"]:
            body["model"] = CFG["model"]
        async with c.stream("POST", openai_url(base, "chat/completions"), json=body) as resp:
            if resp.is_error:
                await resp.aread()
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    d = json.loads(data)["choices"][0].get("delta", {})
                except (ValueError, KeyError, IndexError):
                    continue
                if t := (d.get("reasoning_content") or d.get("reasoning")):
                    yield "thinking", t
                if d.get("content"):
                    yield "content", d["content"]

@app.post("/llm/test")
async def llm_test(b: dict | None = None):
    """Check a server address + key (the values currently typed in Settings, saved or not) and list its models."""
    b = b or {}
    base = (b.get("llm_url") or CFG["llm_url"]).rstrip("/")
    api = b.get("llm_api") or CFG["llm_api"]
    key = clean_key(b.get("api_key")) or CFG["api_key"]
    url = f"{base}/api/tags" if api == "ollama" else openai_url(base, "models")
    try:
        async with httpx.AsyncClient(timeout=10, headers=auth_headers(key), follow_redirects=True) as c:
            r = await c.get(url)
            r.raise_for_status()
            data = r.json()
    except httpx.HTTPStatusError as e:
        return {"ok": False, "error": f"Server answered {explain(e.response)}"}
    except (httpx.HTTPError, ValueError):
        return {"ok": False, "error": "Could not reach that address"}
    items = data.get("models") if api == "ollama" else data.get("data")
    names = [(m.get("name") or m.get("id") or "") for m in (items or []) if isinstance(m, dict)]
    return {"ok": True, "models": sorted(n for n in names if n)[:300]}

async def model_round(ws: WebSocket, text: str, cid: str, slot: dict) -> str:
    """One model reply. Returns "continue" when automatic results were produced and the model should answer
    them, "error" if the model failed, else "stop"."""
    await ws.send_json({"type": "start", "conv_id": cid, "status": "Thinking"})

    prev = slot.get("voice")  # a follow-up reply must not talk over the previous one
    if prev and prev.thread and prev.thread.is_alive():
        await asyncio.to_thread(prev.thread.join, 30)
    voice = None
    eng = await get_tts()
    if eng:
        async def send_audio(b: bytes):
            await ws.send_bytes(b)
        await ws.send_json({"type": "audio_format", "sample_rate": eng.sample_rate})
        voice = slot["voice"] = WordStreamingVoice(eng, send_audio, asyncio.get_running_loop())
        voice.start()
    speak = vc.TTSFilter()

    msgs = [{"role": "system", "content": system_text()}] + merge_roles(context(cid))
    answer = ""
    try:
        async for kind, piece in llm_stream(msgs, want_think(text)):
            if kind == "thinking":
                await ws.send_json({"type": "thinking", "text": piece})  # never spoken
                continue
            answer += piece
            await ws.send_json({"type": "delta", "text": piece})
            if voice and (spoken := speak.feed(piece)):
                voice.add_words(spoken)
        if voice:
            if tail := speak.flush():
                voice.add_words(tail)
            voice.close()
    except httpx.HTTPStatusError as e:
        if voice: voice.cancel()
        code = e.response.status_code
        await ws.send_json({"type": "error", "message": f"Model error {explain(e.response)}"})
        return "error"
    except httpx.HTTPError:
        if voice: voice.cancel()
        await ws.send_json({"type": "error", "message": "Model is offline"})
        return "error"
    except asyncio.CancelledError:
        if voice: voice.cancel()
        add_msg(cid, "assistant", answer + " [stopped]")
        try:
            await ws.send_json({"type": "done", "conv_id": cid, "stopped": True})
        except Exception:
            pass
        raise
    if answer:
        add_msg(cid, "assistant", answer)

    produced = hold = False  # produced: results the model should see now | hold: something waits for the user
    for lang, code in FENCE.findall(answer):
        l = lang.lower()
        if l == "remember":
            if saved := save_memories(code):
                await ws.send_json({"type": "remembered", "items": saved})
            continue
        if l == "skill" and CFG["learn_skills"]:
            if learned := save_skill(code):
                await ws.send_json({"type": "learned_skill", "skill": learned})
            continue
        if l == "tool":
            try:
                r = register_tool_run(code, cid)
            except (ValueError, McpError) as e:  # bad call: tell the model so it can fix it
                add_msg(cid, "code", f"[Automated tool output — not typed by the user. The tool call was not run.]\n{e}")
                produced = True
                continue
        elif l in INTERP and CFG["code_exec"]:
            r = _register(lang, code, cid)
        else:
            continue
        # once one command waits for the user, later ones wait too (they may depend on it)
        if hold or not should_auto(r):
            hold = True
            await ws.send_json({"type": "review", "run": public(r)})
            continue
        r["auto"] = True
        r["status"] = "running"
        await ws.send_json({"type": "review", "run": public(r), "auto": True})
        try:
            await execute(r)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # e.g. interpreter missing
            r.update(status="done", exit_code=1, duration=0, output=f"Could not run: {e}", truncated=False)
        add_msg(cid, "code", format_run_result(r))
        await ws.send_json({"type": "run_result", "run": public(r)})
        produced = True
    return "continue" if produced and not hold else "stop"

async def chat_turn(ws: WebSocket, text: str, cid: str | None, slot: dict):
    cid = cid or new_conv(text)
    add_msg(cid, "user", text)
    steps = 0
    while True:
        outcome = await model_round(ws, text, cid, slot)
        if outcome == "error":
            return
        if outcome != "continue":
            break
        steps += 1
        if steps > CFG["max_agent_steps"]:
            await ws.send_json({"type": "notice", "message":
                                f"Paused after {steps - 1} automatic steps. Send a message to keep going."})
            break
    await ws.send_json({"type": "done", "conv_id": cid})

async def interrupt(ws: WebSocket, slot: dict):
    """Cancel generation and speech. Running commands are only killed by an explicit stop."""
    t = slot.get("task")
    if t and not t.done():
        t.cancel()
        await asyncio.gather(t, return_exceptions=True)
    if v := slot.get("voice"):
        v.cancel(); slot["voice"] = None
    try:
        await ws.send_json({"type": "audio_stop"})
    except Exception:
        pass

@app.websocket("/ws/aurora")
async def ws_aurora(ws: WebSocket):
    await ws.accept()
    slot = {"task": None, "voice": None}
    try:
        while True:
            msg = await ws.receive_json()
            if msg.get("type") == "chat" and msg.get("text", "").strip():
                await interrupt(ws, slot)
                slot["task"] = asyncio.create_task(chat_turn(ws, msg["text"], msg.get("conv_id"), slot))
            elif msg.get("type") == "stop":
                await interrupt(ws, slot)
                for r in RUNS.values():
                    if r["status"] == "running":
                        abort(r)
    except WebSocketDisconnect:
        if (t := slot.get("task")) and not t.done(): t.cancel()
        if v := slot.get("voice"): v.cancel()

# ---------- voice (speech-to-text, voices) ----------
@app.on_event("startup")
async def _load_stt():
    asyncio.get_running_loop().run_in_executor(None, vc.speech.load)

@app.get("/voice/status")
def voice_status():
    return {"stt": vc.speech.ready, "stt_loading": vc.speech.loading, "stt_error": vc.speech.error,
            "tts": Path(CFG["tts_model"]).exists(), "tts_enabled": CFG["tts_enabled"]}

@app.get("/voice/voices")
def voice_voices():
    out = []
    for p in sorted(vc.MODEL_DIR.glob("*.onnx")):
        if Path(str(p) + ".json").exists():  # Piper voices ship a matching .onnx.json
            out.append({"name": p.stem, "path": str(p)})
    return out

@app.post("/speech/transcribe")
async def speech_transcribe(request: Request):
    if not vc.speech.ready:
        detail = "Speech engine is still loading" if vc.speech.loading else (vc.speech.error or "Speech engine is not ready")
        raise HTTPException(503, detail)
    try:
        upload = (await request.form()).get("file")
        if upload is None or not hasattr(upload, "read"):
            raise ValueError("Missing audio file")
        samples = vc.decode_audio_upload(await upload.read())
        if not len(samples):
            raise ValueError("Empty audio")
    except Exception as e:
        raise HTTPException(400, f"Could not read the audio: {e}")
    return {"status": "success", "text": await asyncio.to_thread(vc.speech.transcribe, samples)}

@app.websocket("/ws/live_audio")
async def ws_live_audio(ws: WebSocket):
    await vc.run_live(ws, CFG["stt_silence_seconds"], CFG["stt_max_speech_seconds"])

def public_settings():
    """Settings for the UI. The API key itself never leaves the backend."""
    return {**CFG, "api_key": "", "api_key_set": bool(CFG["api_key"])}

@app.get("/settings")
def get_settings():
    return public_settings()

@app.post("/settings")
def set_settings(patch: dict):
    if not isinstance(patch.get("api_key"), str):
        patch.pop("api_key", None)  # not sent = keep the saved key; "" = clear it
    else:
        patch["api_key"] = clean_key(patch["api_key"])
    for k in ("llm_url", "model"):
        if isinstance(patch.get(k), str):
            patch[k] = patch[k].strip()
    CFG.update({k: v for k, v in patch.items() if k in CFG})
    for k in ("auto_exec", "auto_tools", "auto_python", "auto_bash", "auto_safe_only", "learn_skills"):
        CFG[k] = bool(CFG[k])
    try:
        CFG["max_agent_steps"] = min(30, max(1, int(CFG["max_agent_steps"])))
    except (TypeError, ValueError):
        CFG["max_agent_steps"] = 6
    for k, lo, hi in (("temperature", 0.0, 2.0), ("top_p", 0.01, 1.0)):
        if CFG[k] is not None:  # None = server default
            try:
                CFG[k] = round(min(hi, max(lo, float(CFG[k]))), 3)
            except (TypeError, ValueError):
                CFG[k] = None
    for k, lo, hi, fallback in (("stt_silence_seconds", 0.5, 10.0, 2.5),
                                ("stt_max_speech_seconds", 10.0, 120.0, 45.0)):
        try:
            CFG[k] = round(min(hi, max(lo, float(CFG[k]))), 2)
        except (TypeError, ValueError):
            CFG[k] = fallback
    if not str(CFG["system_prompt"]).strip():
        CFG["system_prompt"] = DEFAULT_PROMPT  # empty = reset to default
    saved = dict(CFG)
    if saved["api_key"] == ENV_KEY:
        saved["api_key"] = ""  # a key that came from the environment stays out of the file
    SETTINGS.write_text(json.dumps(saved, indent=2))
    os.chmod(SETTINGS, stat.S_IRUSR | stat.S_IWUSR)  # the file may hold an API key
    return public_settings()

# ---------- memory ----------
@app.get("/memory")
def memory_list():
    return [{"id": r[0], "text": r[1], "ts": r[2]} for r in db.execute("SELECT id,text,ts FROM memories ORDER BY id DESC")]

@app.post("/memory")
def memory_add(b: dict):
    text = str(b.get("text", "")).strip()
    if not text:
        raise HTTPException(400, "Nothing to remember")
    db.execute("INSERT INTO memories(text,ts) VALUES(?,?)", (text, time.time())); db.commit()
    return {"ok": True}

@app.delete("/memory/{mid}")
def memory_del(mid: int):
    db.execute("DELETE FROM memories WHERE id=?", (mid,)); db.commit()
    return {"ok": True}

# ---------- skills (persistent prompt procedures, manual or model-authored) ----------
@app.get("/skills")
def skills_get():
    return jload(SKILLS, [])

@app.put("/skills")
def skills_put(items: list[dict]):
    clean = [{"id": str(i.get("id") or uuid.uuid4().hex[:8]),
              "title": " ".join(str(i.get("title", "")).split())[:80],
              "description": " ".join(str(i.get("description", "")).split())[:600]} for i in items[:100]]
    SKILLS.write_text(json.dumps(clean, indent=2))
    return clean

# ---------- MCP servers (standard {"mcpServers": {...}} format, see mcp_client.py) ----------
def mcp_config():
    return jload(MCP, {"mcpServers": {}})

_bg: set = set()

def mcp_resync():
    """Connect in the background: the first run of an npx server can take a while. Call from async code."""
    t = asyncio.create_task(hub.sync(mcp_config()))
    _bg.add(t)
    t.add_done_callback(_bg.discard)

@app.on_event("startup")
async def _start_mcp():
    mcp_resync()

@app.on_event("shutdown")
async def _stop_mcp():
    await hub.close()

@app.get("/mcp")
def mcp_get():
    return {"path": str(MCP), "config": mcp_config()}

@app.put("/mcp")
async def mcp_put(cfg: dict):
    servers = cfg.get("mcpServers")
    if not isinstance(servers, dict):
        raise HTTPException(400, "mcpServers must be an object")
    for name, v in servers.items():
        if not isinstance(v, dict) or not (v.get("command") or v.get("url")):
            raise HTTPException(400, f"{name} needs a command or a url")
    MCP.write_text(json.dumps(cfg, indent=2))
    mcp_resync()
    return {"path": str(MCP), "config": cfg}

@app.get("/mcp/status")
def mcp_status():
    cfg = mcp_config()
    return {"servers": hub.status(cfg), "tool_count": len(hub.tools())}

@app.post("/mcp/reload")
async def mcp_reload():
    mcp_resync()  # also retries servers that failed
    return {"ok": True}

# ---------- serve the built React UI (looked up per request, so building later just works) ----------
from fastapi.responses import FileResponse, HTMLResponse

def ui_dirs():
    here = Path(__file__).resolve().parent
    return [Path(p) for p in filter(None, [os.getenv("AURORA_UI")])] + [
        here / "frontend" / "dist", here / "dist", here / "static"]

def find_ui():
    return next((d for d in ui_dirs() if (d / "index.html").is_file()), None)

@app.get("/{path:path}")
def serve_ui(path: str):
    d = find_ui()
    if d is None:
        looked = "".join(f"<li><code>{x}</code></li>" for x in ui_dirs())
        return HTMLResponse(f"""<body style="font:16px system-ui;max-width:640px;margin:60px auto;line-height:1.6">
<h2>Aurora is running, but the interface isn't built yet</h2>
<p>In a terminal:</p><pre>cd {Path(__file__).resolve().parent}/frontend
npm install
npm run build</pre><p>Then refresh this page. No restart needed.</p>
<p>Looked for <code>index.html</code> in:</p><ul>{looked}</ul></body>""")
    f = (d / path).resolve()
    if path and f.is_file() and (d.resolve() in f.parents):
        return FileResponse(f)
    return FileResponse(d / "index.html")
