# Aurora desktop

From this directory, start the complete desktop app with:

```bash
npm start
```

The startup command builds the React interface, starts the FastAPI backend when it is not already running, then opens Aurora in Electron. By default the backend listens only on `127.0.0.1:8765`.

## Start automatically with systemd

Aurora includes a user service that runs the production build, not a Vite live/development server. Build once, link the service, and enable it for the graphical login session:

```bash
npm run build
systemctl --user link "$PWD/systemd/aurora.service"
systemctl --user enable --now aurora.service
```

After source changes, run `npm run build` and restart with `systemctl --user restart aurora.service`. Logs and status are available with:

```bash
systemctl --user status aurora.service
journalctl --user -u aurora.service -f
```

To turn off automatic startup, use `systemctl --user disable --now aurora.service`.

## Live speech

Live listening waits 2.5 seconds of silence before sending an utterance, allowing pauses and word-searching without cutting the sentence off. Change **Live listening pause before send** in Settings (0.5–10 seconds). The continuous utterance cap defaults to 45 seconds and is configurable there too.

When **Let Aurora save new reusable skills it learns** is enabled, Aurora may persist a new, validated prompt skill if none with the same name exists. Learned skills appear in the Skills tab and remain editable or removable. They are instructions, not automatically installed executable code.

If the standard virtual environment is unavailable, Electron falls back to `python3 -m uvicorn`. Set `AURORA_UVICORN` or `AURORA_PYTHON` to override that choice.
