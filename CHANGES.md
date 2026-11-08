# Aurora patch: what changed

Unzip over your project (same folder layout). `frontend/dist` is already rebuilt; run `npm run build` in `frontend/` only if you edit the UI again. No new Python or npm dependencies.

## 1. MCP now works
- New `mcp_client.py`: a small MCP client with stdio, streamable-HTTP and legacy-SSE transports (URL ending in `/sse`, or `"transport": "sse"`).
- Enabled servers in `mcp.json` connect at startup and when you save in the Tools panel. Their tools are listed in the system prompt.
- The model calls a tool with a fenced block: ```` ```tool {"server":"fs","tool":"read_file","arguments":{...}} ``` ````. The result goes back to it automatically. Bad calls (unknown tool, bad JSON) are returned to the model with the list of valid tools so it can correct itself.
- Tool calls use the same Run / Edit / Reject cards as scripts.
- Tools panel shows live status per server (connected + tool names, connecting, error text), a tool count and a Reconnect button.
- Endpoints: `GET /mcp/status`, `POST /mcp/reload`.

## 2. Electron resizing
- Cause: CSS used `100vh` / `96vw` for the island, but the window was sized to the island, so the island kept shrinking itself.
- Now the island has explicit pixel sizes, and the window is island size plus a fixed shadow margin (`PAD`, same value in `App.jsx`, `styles.css`, `electron/main.js`).
- The window grows immediately and shrinks after the animation, and is limited to the screen work area.
- Drag the corner grip of the expanded panel to resize it (double-click resets). The size is remembered.
- Links in replies open in your browser instead of a new Aurora window.

## 3. API endpoints
- Settings: API key field (stored in `settings.json` with mode 0600, never sent back to the UI; `LLM_API_KEY` / `OPENAI_API_KEY` env vars also work), "Test connection" button that lists the server's models.
- URL handling covers `.../v1`, OpenRouter, Gemini's `/v1beta/openai`, and full `/chat/completions` URLs.
- `chat_template_kwargs` is only sent to local servers (hosted APIs reject it). Errors now say 401 / 404 / 429 clearly.

## 4. Markdown in chat
- New dependency-free `markdown.jsx`: headings, bold/italic/strike, inline code, links, lists, quotes, tables, rules. It builds React elements, never raw HTML, and only http(s)/mailto links.

## 5. Auto mode for commands (reworked in round 2)
- **Bolt button in the bar** (works collapsed or expanded): one click turns auto-run on or off.
- **Controls tab**: separate switches for **Tools (MCP)**, **Python** and **Bash**, and "Hold risky ones for my review" (flagged scripts such as sudo / rm -r, and tools marked destructive, still wait for you; turn it off for fully hands-off).
- Auto-run output is appended to the conversation as the next message and the model carries on by itself, up to "Automatic follow-up steps" per message (default 6).
- Stop kills the running script or tool call.
- Old `exec_mode` settings are migrated automatically (auto_safe -> on + hold risky, auto -> on, ask -> off).
- **Console jump is a setting**: "Switch to the Console tab when something runs (also in auto mode)", on by default; stored in this browser.
- Consecutive same-role messages are merged before sending, so strict chat templates do not choke on command output.

## 6. Temperature and top-p
- Two sliders in the Controls tab (temperature 0-2, top-p 0.05-1), saved as you drag.
- Each has "Use the server's default", which leaves the value out of the request entirely (use this for hosted reasoning models that reject temperature).
- Sent as `temperature` / `top_p` for OpenAI-style servers and as `options` for Ollama.

## Also
- `vite.config.js` dev proxy now forwards `/voice /speech /memory /skills /mcp /llm /ws`.

## Not covered
- The old duplicate files one level up (`files/backend.py`, `files/main.js`, ...) were not touched; use the `aurora/` copies.
- `_default_prompt()` still points at `/home/kelvin/projects/ai/markdowns/BASH_ROAST.md`.

---
# Round 3: readme.txt items

## Fixes
- **Unreadable text**: `textarea` never inherited the light text colour (black on dark in Skills, the Tools JSON box, the Run editor and "Return with comment"); the Controls number box was white-on-white. Both fixed, and `color-scheme: dark` is set.
- **Model dropdown did nothing**: native `<select>` / `<datalist>` popups are separate OS windows and open behind the always-on-top Electron window. All dropdowns (Server type, Model, Thinking, Voice) are now drawn in the page (`dropdown.jsx`). The Model box is editable and loads the server's model list when opened.
- **Minimize**: new button left of the status (Electron: hides to the system tray, with a tray icon: click to show/hide, right-click for Quit; in a browser tab it retracts to the pill).
- **Esc** no longer stops anything. It only tucks the island away one step (expanded -> bar -> pill). Use the Stop button.

## Theme
- Dark green palette, 2px radius everywhere, monospace UI font, 2px green island border (all in the `:root` block of `styles.css`).
- Expanding/contracting uses damped-spring easings (CSS `linear()`): growing overshoots and settles, width and height at different speeds, a green glow while moving; shrinking settles without undershoot. The Electron window gets extra room while the island moves.

New files: `frontend/src/dropdown.jsx`, `electron/tray.png`. Changed: `App.jsx`, `styles.css`, `electron/main.js`, `electron/preload.js`, `frontend/dist/*` (rebuilt).

---
# Autonomous execution policy

- Auto-run now defaults on for MCP tools, Python, and Bash.
- MCP tool calls auto-run regardless of their destructive annotation.
- Review holds apply only to Bash/Python source lines matching the language-specific dangerous-operation patterns.
- The Controls label now reflects this policy.
