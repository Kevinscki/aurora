const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, screen, session, shell } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

// Force Electron through X11/XWayland under KDE Wayland.
app.commandLine.appendSwitch("ozone-platform", "x11");
app.commandLine.appendSwitch("enable-transparent-visuals");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");   // no permission prompt for the mic
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const PORT = process.env.AURORA_PORT || "8765";
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, "..");


let win = null;
let tray = null;
let backend = null;
let xpropAvailable = true;
let blurTimer = null;
let blurProcess = null;
let pendingBlurRegion = null;
let appliedBlurRegion = "";
let lastBlurUpdate = 0;
let shapeCommitTimer = null;
let lastAnimatedRegion = null;
let lastRequestedSize = null;

// CSS backdrop-filter only sees pixels already painted inside Chromium; it cannot
// blur the desktop behind a transparent Electron window. KWin exposes native
// desktop blur for X11/XWayland clients through this property. Aurora is started
// with --ozone-platform=x11 specifically so this works in a Plasma Wayland session.
const KWIN_BLUR_PROPERTY = "_KDE_NET_WM_BLUR_BEHIND_REGION";

const BLUR_FRAME_MS = 20;

function setKwinBlurRegion(region) {
  if (process.platform !== "linux") return;
  if (!process.env.DISPLAY || !win || !xpropAvailable) {
    setLinuxWindowShape(region);
    return;
  }

  // Electron identifies Linux desktop-capture windows by their X11 Window ID.
  // Using that ID avoids guessing the byte order/size of the native-handle buffer.
  const match = /^window:(\d+):/.exec(win.getMediaSourceId());
  if (!match) {
    setLinuxWindowShape(region);
    return;
  }

  if (!region || ![region.x, region.y, region.width, region.height].every(Number.isFinite)) return;
  const values = [region.x, region.y, region.width, region.height].map((value) => Math.max(0, Math.round(value)));
  if (values[2] < 1 || values[3] < 1) return;
  const serialized = values.join(",");
  if (serialized === appliedBlurRegion) {
    setLinuxWindowShape(region);
    return;
  }
  appliedBlurRegion = serialized;

  // Restrict blur to the island itself. Blurring the transparent shell padding
  // creates a visible rectangle around the dynamic island. Never kill an
  // in-flight xprop process: rapidly replacing it made KWin briefly clear and
  // repaint the blur surface, which showed up as a flash during expansion.
  const proc = spawn("xprop", [
    "-id", match[1],
    "-f", KWIN_BLUR_PROPERTY, "32c",
    "-set", KWIN_BLUR_PROPERTY, values.join(",")
  ], { stdio: "ignore" });

  // xprop is optional: non-KDE desktops simply keep normal transparency.
  blurProcess = proc;
  proc.once("error", () => { xpropAvailable = false; });
  proc.once("close", () => {
    if (blurProcess !== proc) return;
    blurProcess = null;
    lastBlurUpdate = Date.now();
    const previousArea = lastAnimatedRegion
      ? lastAnimatedRegion.width * lastAnimatedRegion.height
      : 0;
    const nextArea = region.width * region.height;
    const contracting = previousArea > 0 && nextArea < previousArea - 1;
    const expanding = previousArea > 0 && nextArea > previousArea + 1;
    lastAnimatedRegion = region;

    // A stale smaller native shape clips a growing CSS frame and makes a 60 Hz
    // animation look like the xprop update rate. Growth is opened in place()
    // before it starts, so only tighten the shape while contracting.
    if (contracting) {
      // Damage the complete retained surface once while the smaller blur region
      // is active, then crop it on the next frame. This clears pixels that would
      // otherwise sit outside the new shape until KWin's next incidental repaint.
      if (win && !win.webContents.isDestroyed()) win.webContents.invalidate();
      if (shapeCommitTimer) clearTimeout(shapeCommitTimer);
      shapeCommitTimer = setTimeout(() => {
        shapeCommitTimer = null;
        setLinuxWindowShape(region);
      }, 16);
    } else if (expanding && win) {
      // Also handle a rapid direction reversal before the delayed size IPC has
      // had a chance to announce growth.
      if (shapeCommitTimer) clearTimeout(shapeCommitTimer);
      shapeCommitTimer = null;
      const bounds = win.getBounds();
      win.setShape([{ x: 0, y: 0, width: bounds.width, height: bounds.height }]);
    }
    if (pendingBlurRegion) queueKwinBlurRegion(pendingBlurRegion);
  });
}

function queueKwinBlurRegion(region) {
  pendingBlurRegion = region;
  if (blurTimer || blurProcess) return;
  // Throttle instead of debounce. A debounce left KWin using the old, small
  // region for the whole CSS transition and then jumped to the final rectangle.
  const delay = Math.max(0, BLUR_FRAME_MS - (Date.now() - lastBlurUpdate));
  blurTimer = setTimeout(() => {
    blurTimer = null;
    const next = pendingBlurRegion;
    pendingBlurRegion = null;
    setKwinBlurRegion(next);
  }, delay);
}

// Window = island + this margin (room for the shadow). Keep in sync with PAD in frontend/src/App.jsx
// and .stage padding in styles.css. The renderer sends the full window size; this is only used for the
// first frame, before the UI has loaded.
const PAD = { x: 20, top: 10, bottom: 32 };
const START = { w: 190 + 2 * PAD.x, h: 38 + PAD.top + PAD.bottom }; // the retracted pill

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function backendUp() {
  try {
    return (await fetch(`${URL}/voice/status`)).ok;
  } catch {
    return false;
  }
}

async function ensureBackend() {
  if (await backendUp()) return;

  const configured = process.env.AURORA_UVICORN || "/home/kelvin/.envi/bin/uvicorn";
  const hasUvicorn = fs.existsSync(configured);
  const command = hasUvicorn ? configured : (process.env.AURORA_PYTHON || "python3");
  const args = hasUvicorn
    ? ["backend:app", "--host", "127.0.0.1", "--port", PORT]
    : ["-m", "uvicorn", "backend:app", "--host", "127.0.0.1", "--port", PORT];
  console.log(`[aurora] starting backend with ${command} ${args.join(" ")}`);
  backend = spawn(
    command,
    args,
    {
      cwd: ROOT,
      env: hasUvicorn
        ? { ...process.env, VIRTUAL_ENV: path.dirname(path.dirname(command)), PATH: path.dirname(command) + path.delimiter + (process.env.PATH || "") }
        : process.env,
      stdio: "inherit"
    }
  );
  backend.once("error", (error) => console.error("[aurora] could not start backend:", error.message));

  for (let i = 0; i < 120 && !(await backendUp()); i++) {
    await sleep(500);
  }
  if (!(await backendUp())) console.error("[aurora] backend did not start; check the Python path and its packages");
}

function place(w, h) {
  if (!win || !Number.isFinite(w) || !Number.isFinite(h)) return;
  const wa = screen.getPrimaryDisplay().workArea;

  const requestedW = Math.min(Math.ceil(w), wa.width);
  const requestedH = Math.min(Math.ceil(h), wa.height);
  const previousRequestedArea = lastRequestedSize
    ? lastRequestedSize.width * lastRequestedSize.height
    : 0;
  const growing = requestedW * requestedH > previousRequestedArea;
  lastRequestedSize = { width: requestedW, height: requestedH };
  let W = requestedW;
  let H = requestedH;

  // Shrinking a transparent X11 BrowserWindow makes KWin destroy and recreate
  // its compositor surface, producing a one-frame flash. Retain the largest
  // native surface on Linux; only the island and its native blur region shrink.
  // Mouse handling for the transparent remainder is disabled below.
  if (process.platform === "linux" && win.isVisible()) {
    const current = win.getBounds();
    W = Math.max(W, current.width);
    H = Math.max(H, current.height);
  }

  const next = {
    x: Math.round(wa.x + (wa.width - W) / 2),
    y: wa.y,
    width: W,
    height: H
  };
  const current = win.getBounds();
  if (current.x !== next.x || current.y !== next.y || current.width !== next.width || current.height !== next.height) {
    win.setBounds(next);
  }
  // Reveal the complete retained surface before a grow animation, including
  // re-expansion when the native bounds are already large enough.
  if (process.platform === "linux" && growing) {
    if (shapeCommitTimer) clearTimeout(shapeCommitTimer);
    shapeCommitTimer = null;
    win.setShape([{ x: 0, y: 0, width: W, height: H }]);
  }
}

function setLinuxWindowShape(region) {
  if (process.platform !== "linux" || !win) return;
  const bounds = win.getBounds();
  const x = Math.max(0, Math.floor(region.x - PAD.x));
  const y = Math.max(0, Math.floor(region.y - PAD.top));
  const width = Math.min(bounds.width - x, Math.ceil(region.width + 2 * PAD.x));
  const height = Math.min(bounds.height - y, Math.ceil(region.height + PAD.top + PAD.bottom));
  if (width > 0 && height > 0) win.setShape([{ x, y, width, height }]);
}

// Show or hide the island. The window has no taskbar entry (skipTaskbar), so the tray icon is the
// way back after "minimize".
function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    win.webContents.send("aurora:shown");
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, "tray.png"));
  tray = new Tray(icon);
  tray.setToolTip("Aurora");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Show / hide Aurora", click: toggleWindow },
      { label: "Open in browser", click: () => shell.openExternal(URL) },
      { type: "separator" },
      { label: "Quit Aurora", click: () => app.quit() }
    ])
  );
  tray.on("click", toggleWindow);
}

function createWindow() {
  lastAnimatedRegion = null;
  lastRequestedSize = null;
  win = new BrowserWindow({
    width: START.w,
    height: START.h,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    // macOS uses vibrancy; KDE/X11 is enabled below once the native window exists.
    ...(process.platform === "darwin" ? { vibrancy: "under-window", visualEffectState: "active" } : {}),
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,

    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js")
    }
  });

  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true);

  place(START.w, START.h);

  win.once("ready-to-show", () => win.show());

  // KWin and macOS already blur the desktop at the native-window layer. Tell
  // the renderer not to stack Chromium's backdrop-filter on top while the
  // surface is resizing; that second live filter flashes on X11 contraction.
  const nativeBlur = process.platform === "darwin"
    || (process.platform === "linux" && /KDE/i.test(process.env.XDG_CURRENT_DESKTOP || ""));
  win.loadURL(`${URL}/?shell=1${nativeBlur ? "&nativeBlur=1" : ""}`);
  if (process.env.AURORA_DEVTOOLS) win.webContents.openDevTools({ mode: "detach" });

  // Links in replies open in the real browser, never in a new Aurora window.
  const external = (u) => /^(https?:|mailto:)/i.test(u) && shell.openExternal(u);
  win.webContents.setWindowOpenHandler(({ url }) => {
    external(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(URL)) {
      e.preventDefault();
      external(url);
    }
  });

  win.webContents.on("context-menu", (_e, params) => {
    if (params.isEditable || params.selectionText) return;

    Menu.buildFromTemplate([
      {
        label: "Open in browser",
        click: () => shell.openExternal(URL)
      },
      {
        label: "Quit Aurora",
        click: () => app.quit()
      }
    ]).popup();
  });

  win.on("closed", () => {
    if (shapeCommitTimer) clearTimeout(shapeCommitTimer);
    shapeCommitTimer = null;
    win = null;
  });
}

// "Minimize" button in the island: hide to the tray.
ipcMain.on("aurora:minimize", () => {
  if (win) win.hide();
});

ipcMain.on("aurora:size", (_e, w, h) => {
  if (win) place(Number(w), Number(h));
});

ipcMain.on("aurora:blur-region", (_e, x, y, width, height) => {
  const region = { x: Number(x), y: Number(y), width: Number(width), height: Number(height) };
  if (![region.x, region.y, region.width, region.height].every(Number.isFinite)) return;
  // The blur queue applies the matching native shape after KWin acknowledges
  // this region, keeping compositor damage and the visible surface in lockstep.
  queueKwinBlurRegion(region);
});

// The space the island may grow into (the screen minus panels and taskbars).
ipcMain.handle("aurora:workarea", () => {
  const { width, height } = screen.getPrimaryDisplay().workArea;
  return { width, height };
});

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => {
    cb(["media", "audioCapture", "microphone"].includes(perm));
  });

  session.defaultSession.setPermissionCheckHandler((_wc, perm) => {
    return ["media", "audioCapture", "microphone"].includes(perm);
  });

  await ensureBackend();
  createWindow();
  createTray();
});

app.on("window-all-closed", () => app.quit());

app.on("before-quit", () => {
  if (backend) backend.kill();
});
