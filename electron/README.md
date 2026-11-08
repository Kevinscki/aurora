# Aurora desktop

From this directory, start the complete desktop app with:

```bash
npm start
```

The startup command builds the React interface, starts the FastAPI backend when it is not already running, then opens Aurora in Electron. By default the backend listens only on `127.0.0.1:8765`.

## Start automatically with systemd

Aurora includes a portable installer for a **user service**. It installs the
dependencies, builds the production frontend, generates a service containing
the current clone's absolute path, and enables it for the graphical login
session. Do not use `sudo`:

```bash
./systemd/install.sh
```

From the `electron/` directory, the equivalent npm command is
`npm run systemd:install`.

The generated unit is written to
`~/.config/systemd/user/aurora.service`. After source changes, rebuild and
restart Aurora with:

```bash
npm run build
systemctl --user restart aurora.service
```

Logs and status are available with:

```bash
systemctl --user status aurora.service
journalctl --user -u aurora.service -f
```

To stop Aurora without disabling startup:

```bash
systemctl --user stop aurora.service
```

To disable startup and remove the generated unit:

```bash
./systemd/uninstall.sh
```

Use `./systemd/install.sh --no-install` to regenerate the service without
running `npm ci` or rebuilding. Use `--dry-run` to inspect the generated unit
without changing systemd.

## Live speech

Live listening waits 2.5 seconds of silence before sending an utterance, allowing pauses and word-searching without cutting the sentence off. Change **Live listening pause before send** in Settings (0.5–10 seconds). The continuous utterance cap defaults to 45 seconds and is configurable there too.

When **Let Aurora save new reusable skills it learns** is enabled, Aurora may persist a new, validated prompt skill if none with the same name exists. Learned skills appear in the Skills tab and remain editable or removable. They are instructions, not automatically installed executable code.

If the standard virtual environment is unavailable, Electron falls back to `python3 -m uvicorn`. Set `AURORA_UVICORN` or `AURORA_PYTHON` to override that choice.
