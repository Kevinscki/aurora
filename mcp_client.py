"""Minimal MCP (Model Context Protocol) client for Aurora. No third-party SDK needed.

Transports
  stdio            {"command": "npx", "args": [...], "env": {...}}
  streamable HTTP  {"url": "https://host/mcp", "headers": {...}}
  legacy SSE       {"url": "http://host/sse"}   (auto-detected from a /sse URL, or "transport": "sse")

Only httpx (already an Aurora dependency) is needed, and only for URL servers.
"""
import asyncio, json, os, shutil, signal
from urllib.parse import urljoin

PROTOCOL = "2025-03-26"
CLIENT = {"name": "aurora", "version": "0.2"}


class McpError(Exception):
    pass


def _result_text(res: dict) -> tuple[str, bool]:
    """Flatten a tools/call result into (text, is_error)."""
    parts = []
    for c in res.get("content") or []:
        t = c.get("type")
        if t == "text":
            parts.append(c.get("text", ""))
        elif t == "image":
            parts.append(f"[image: {c.get('mimeType', 'unknown')}, not shown]")
        elif t == "resource":
            rs = c.get("resource") or {}
            parts.append(rs.get("text") or f"[resource: {rs.get('uri', '')}]")
        else:
            parts.append(json.dumps(c))
    if not parts and res.get("structuredContent") is not None:
        parts.append(json.dumps(res["structuredContent"], indent=2))
    return "\n".join(parts) or "(no output)", bool(res.get("isError"))


class McpServer:
    def __init__(self, name: str, cfg: dict):
        self.name, self.cfg = name, cfg
        self.tools: list[dict] = []
        self.ready = False
        self._next = 1
        self._pending: dict[int, asyncio.Future] = {}
        self._proc = None
        self._tasks: list[asyncio.Task] = []
        self._http = None
        self._session = None      # streamable-HTTP session id
        self._proto = PROTOCOL
        self._post_url = None     # legacy SSE: where to POST
        self._endpoint_evt = None
        self.stderr_tail = ""
        url = cfg.get("url")
        self.kind = ("sse" if (cfg.get("transport") == "sse" or (url and url.rstrip("/").endswith("/sse")))
                     else "http") if url else "stdio"

    # ---------------- lifecycle ----------------
    async def connect(self):
        if self.kind == "stdio":
            await self._start_stdio()
        elif self.kind == "sse":
            await self._start_sse()
        timeout = float(self.cfg.get("startup_timeout", 90))  # first npx run may download packages
        res = await self.request("initialize", {"protocolVersion": PROTOCOL, "capabilities": {},
                                                "clientInfo": CLIENT}, timeout=timeout)
        self._proto = res.get("protocolVersion") or PROTOCOL
        await self.notify("notifications/initialized")
        self.tools = await self._list_tools()
        self.ready = True

    async def close(self):
        self.ready = False
        for t in self._tasks:
            t.cancel()
        self._tasks.clear()
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(McpError("server closed"))
        self._pending.clear()
        p, self._proc = self._proc, None
        if p and p.returncode is None:
            try:
                os.killpg(p.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                try:
                    p.terminate()
                except ProcessLookupError:
                    pass
            try:
                await asyncio.wait_for(p.wait(), 3)
            except asyncio.TimeoutError:
                try:
                    os.killpg(p.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    pass
        if self._http:
            try:
                await self._http.aclose()
            except Exception:
                pass
            self._http = None

    # ---------------- stdio ----------------
    async def _start_stdio(self):
        cmd = self.cfg["command"]
        env = {**os.environ, **{k: str(v) for k, v in (self.cfg.get("env") or {}).items()}}
        try:
            self._proc = await asyncio.create_subprocess_exec(
                shutil.which(cmd, path=env.get("PATH")) or cmd, *[str(a) for a in self.cfg.get("args") or []],
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                env=env, cwd=self.cfg.get("cwd") or None, start_new_session=True,
                limit=32 * 1024 * 1024)  # tool results can be one very long JSON line
        except (FileNotFoundError, PermissionError) as e:
            raise McpError(f"Could not start '{cmd}': {e.strerror or e}")
        self._tasks.append(asyncio.create_task(self._stdio_reader()))
        self._tasks.append(asyncio.create_task(self._stderr_reader()))

    async def _stdio_reader(self):
        try:
            while line := await self._proc.stdout.readline():
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue  # stray log line on stdout
                await self._on_message(msg)
        except Exception:
            pass
        finally:
            self._dead("server process exited" + (f": {self.stderr_tail.strip()[-300:]}" if self.stderr_tail.strip() else ""))

    async def _stderr_reader(self):
        try:
            while chunk := await self._proc.stderr.read(4096):
                self.stderr_tail = (self.stderr_tail + chunk.decode(errors="replace"))[-2000:]
        except Exception:
            pass

    def _dead(self, why: str):
        self.ready = False
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(McpError(why))
        self._pending.clear()

    # ---------------- legacy SSE ----------------
    async def _start_sse(self):
        import httpx
        self._http = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=15), follow_redirects=True)
        self._endpoint_evt = asyncio.Event()
        self._tasks.append(asyncio.create_task(self._sse_reader()))
        try:
            await asyncio.wait_for(self._endpoint_evt.wait(), 20)
        except asyncio.TimeoutError:
            raise McpError("SSE server did not announce a message endpoint")

    async def _sse_reader(self):
        headers = {"Accept": "text/event-stream", **(self.cfg.get("headers") or {})}
        try:
            async with self._http.stream("GET", self.cfg["url"], headers=headers) as r:
                if r.status_code >= 400:
                    raise McpError(f"HTTP {r.status_code} from {self.cfg['url']}")
                async for event, data in _sse_events(r):
                    if event == "endpoint":
                        self._post_url = urljoin(self.cfg["url"], data.strip())
                        self._endpoint_evt.set()
                    elif event in ("message", ""):
                        try:
                            await self._on_message(json.loads(data))
                        except ValueError:
                            pass
        except Exception as e:
            self._dead(f"SSE connection lost: {e}")
        else:
            self._dead("SSE connection closed")

    # ---------------- JSON-RPC plumbing ----------------
    async def _on_message(self, msg: dict):
        if "id" in msg and ("result" in msg or "error" in msg):
            fut = self._pending.pop(msg["id"], None)
            if fut and not fut.done():
                if "error" in msg:
                    fut.set_exception(McpError((msg["error"] or {}).get("message", "MCP error")))
                else:
                    fut.set_result(msg.get("result") or {})
        elif "method" in msg and "id" in msg:  # request from the server
            if msg["method"] == "ping":
                await self._write({"jsonrpc": "2.0", "id": msg["id"], "result": {}})
            else:
                await self._write({"jsonrpc": "2.0", "id": msg["id"],
                                   "error": {"code": -32601, "message": "Not supported by Aurora"}})

    async def _write(self, obj: dict):
        if self.kind == "stdio":
            if not self._proc or self._proc.returncode is not None:
                raise McpError("server is not running")
            try:
                self._proc.stdin.write((json.dumps(obj) + "\n").encode())
                await self._proc.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                raise McpError("server closed its input")
        elif self.kind == "sse":
            r = await self._http.post(self._post_url, json=obj, headers=self.cfg.get("headers") or {})
            if r.status_code >= 400:
                raise McpError(f"HTTP {r.status_code} from message endpoint")

    async def notify(self, method: str, params: dict | None = None):
        msg = {"jsonrpc": "2.0", "method": method, **({"params": params} if params else {})}
        if self.kind == "http":
            await self._http_post(msg, None, 30)
        else:
            await self._write(msg)

    async def request(self, method: str, params: dict | None = None, timeout: float = 60):
        rid = self._next
        self._next += 1
        msg = {"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}}
        if self.kind == "http":
            reply = await self._http_post(msg, rid, timeout)
            if "error" in reply:
                raise McpError((reply["error"] or {}).get("message", "MCP error"))
            return reply.get("result") or {}
        fut = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        try:
            await self._write(msg)
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            raise McpError(f"{method} timed out after {timeout:g}s")
        finally:
            self._pending.pop(rid, None)

    # ---------------- streamable HTTP ----------------
    async def _http_post(self, payload: dict, want_id, timeout: float) -> dict:
        import httpx
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=15), follow_redirects=True)
        headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream",
                   **(self.cfg.get("headers") or {})}
        if self._session:
            headers["Mcp-Session-Id"] = self._session
            headers["MCP-Protocol-Version"] = self._proto

        async def go():
            async with self._http.stream("POST", self.cfg["url"], json=payload, headers=headers) as r:
                if sid := r.headers.get("mcp-session-id"):
                    self._session = sid
                if r.status_code >= 400:
                    body = (await r.aread()).decode(errors="replace")[:200]
                    raise McpError(f"HTTP {r.status_code} {body}".strip())
                if want_id is None:  # notification: 202 Accepted, nothing to read
                    return {}
                if "text/event-stream" in r.headers.get("content-type", ""):
                    async for _event, data in _sse_events(r):
                        try:
                            m = json.loads(data)
                        except ValueError:
                            continue
                        for x in (m if isinstance(m, list) else [m]):
                            if x.get("id") == want_id and ("result" in x or "error" in x):
                                return x
                    raise McpError("stream ended without a reply")
                m = json.loads(await r.aread())
                for x in (m if isinstance(m, list) else [m]):
                    if x.get("id") == want_id:
                        return x
                raise McpError("reply did not match the request")

        try:
            return await asyncio.wait_for(go(), timeout)
        except asyncio.TimeoutError:
            raise McpError(f"{payload.get('method')} timed out after {timeout:g}s")
        except httpx.HTTPError as e:
            raise McpError(f"connection failed: {e}")

    # ---------------- MCP calls ----------------
    async def _list_tools(self) -> list[dict]:
        out, cursor = [], None
        for _ in range(20):
            res = await self.request("tools/list", {"cursor": cursor} if cursor else {}, timeout=30)
            out += res.get("tools") or []
            cursor = res.get("nextCursor")
            if not cursor:
                break
        return out

    async def call_tool(self, tool: str, args: dict, timeout: float = 120) -> tuple[str, bool]:
        res = await self.request("tools/call", {"name": tool, "arguments": args or {}}, timeout=timeout)
        return _result_text(res)


async def _sse_events(resp):
    """Yield (event, data) from a Server-Sent-Events response."""
    event, data = "", []
    async for line in resp.aiter_lines():
        if line == "":
            if data:
                yield event, "\n".join(data)
            event, data = "", []
        elif line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].lstrip(" "))
    if data:
        yield event, "\n".join(data)


def _type(v: dict) -> str:
    if not isinstance(v, dict):
        return "any"
    if v.get("enum"):
        return "|".join(json.dumps(x) if not isinstance(x, str) else x for x in v["enum"][:8])
    t = v.get("type")
    return "/".join(t) if isinstance(t, list) else (t or "any")


class McpHub:
    """All connected servers. Aurora's backend talks only to this."""

    def __init__(self):
        self.servers: dict[str, McpServer] = {}
        self.errors: dict[str, str] = {}
        self.connecting: set[str] = set()
        self.cfg: dict = {}
        self._lock = asyncio.Lock()

    async def sync(self, cfg: dict):
        """Make running servers match the config. Failed servers are retried on every call."""
        self.cfg = cfg
        async with self._lock:
            want = {n: c for n, c in (cfg.get("mcpServers") or {}).items()
                    if isinstance(c, dict) and not c.get("disabled")}
            for n in list(self.servers):
                s = self.servers[n]
                if n not in want or s.cfg != want[n] or not s.ready:
                    await self.servers.pop(n).close()
            for n in list(self.errors):
                if n not in want:
                    del self.errors[n]
            todo = [n for n in want if n not in self.servers]
            self.connecting |= set(todo)

            async def one(n):
                s = McpServer(n, want[n])
                try:
                    await s.connect()
                    self.servers[n] = s
                    self.errors.pop(n, None)
                except Exception as e:
                    self.errors[n] = str(e) or type(e).__name__
                    await s.close()
                finally:
                    self.connecting.discard(n)

            await asyncio.gather(*(one(n) for n in todo))

    async def close(self):
        for s in list(self.servers.values()):
            await s.close()
        self.servers.clear()

    def tools(self) -> list[dict]:
        out = []
        for s in self.servers.values():
            if not s.ready:
                continue
            for t in s.tools:
                out.append({"server": s.name, "name": t.get("name", ""), "description": t.get("description", ""),
                            "schema": t.get("inputSchema") or {},
                            "readonly": bool((t.get("annotations") or {}).get("readOnlyHint")),
                            "destructive": (t.get("annotations") or {}).get("destructiveHint") is True})
        return out

    def status(self, cfg: dict) -> list[dict]:
        rows = []
        for n, c in (cfg.get("mcpServers") or {}).items():
            s = self.servers.get(n)
            if isinstance(c, dict) and c.get("disabled"):
                state = "off"
            elif s and s.ready:
                state = "connected"
            elif n in self.connecting:
                state = "connecting"
            else:
                state = "error" if n in self.errors else "connecting"
            rows.append({"name": n, "state": state, "error": self.errors.get(n),
                         "tools": [t.get("name") for t in (s.tools if s and s.ready else [])]})
        return rows

    def resolve(self, server: str | None, tool: str | None) -> dict:
        """Find a tool the model asked for. Accepts "tool", "server.tool" and a missing server."""
        tools = self.tools()
        if not tools:
            raise McpError("No tools are connected right now.")
        tool = (tool or "").strip()
        server = (server or "").strip()
        if not server and "." in tool:
            maybe, rest = tool.split(".", 1)
            if any(t["server"] == maybe for t in tools):
                server, tool = maybe, rest
        pool = [t for t in tools if t["name"] == tool and (not server or t["server"] == server)]
        if len(pool) == 1:
            return pool[0]
        names = ", ".join(f"{t['server']}.{t['name']}" for t in tools[:40])
        if len(pool) > 1:
            raise McpError(f"Tool '{tool}' exists on several servers; add \"server\". Options: "
                           + ", ".join(f"{t['server']}.{t['name']}" for t in pool))
        raise McpError(f"Unknown tool '{server + '.' if server else ''}{tool}'. Available tools: {names}")

    async def call(self, server: str, tool: str, args: dict, timeout: float = 120) -> tuple[str, bool]:
        s = self.servers.get(server)
        if not s or not s.ready:  # server died: try one reconnect
            await self.sync(self.cfg)
            s = self.servers.get(server)
        if not s or not s.ready:
            raise McpError(f"Server '{server}' is not connected: {self.errors.get(server, 'unknown reason')}")
        return await s.call_tool(tool, args, timeout)

    def prompt_block(self) -> str:
        tools = self.tools()
        if not tools:
            return ""
        for per in (300, 120, 60):  # shrink descriptions if the list is long (small local models)
            lines = []
            for t in tools:
                props = t["schema"].get("properties") or {}
                req = set(t["schema"].get("required") or [])
                sig = ", ".join(f"{k}{'*' if k in req else ''}: {_type(v)}" for k, v in list(props.items())[:12])
                desc = " ".join((t["description"] or "").split())[:per]
                lines.append(f"- {t['server']}.{t['name']}({sig})" + (f" - {desc}" if desc else ""))
            if sum(len(x) for x in lines) < 6000:
                break
        return ("You can use external tools. To call one, reply with a fenced block whose language is tool "
                "and whose content is JSON, like this:\n"
                "```tool\n{\"server\": \"SERVER\", \"tool\": \"TOOL\", \"arguments\": {\"param\": \"value\"}}\n```\n"
                "Make one tool call per reply, then stop: the result is sent back to you automatically. "
                "Parameters marked * are required. Do not invent tools that are not listed.\n"
                "Available tools:\n" + "\n".join(lines))
