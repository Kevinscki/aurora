const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aurora", {
  // window size in CSS pixels (the renderer already includes the shadow margin)
  resize: (width, height) => {
    ipcRenderer.send("aurora:size", width, height);
  },
  // CSS-pixel bounds of the island within the transparent native window.
  blurRegion: (x, y, width, height) => {
    ipcRenderer.send("aurora:blur-region", x, y, width, height);
  },
  // { width, height } of the screen's work area
  workArea: () => ipcRenderer.invoke("aurora:workarea"),
  // hide the window to the system tray
  minimize: () => ipcRenderer.send("aurora:minimize"),
  // called when the window is brought back from the tray; returns an unsubscribe function
  onShown: (cb) => {
    const fn = () => cb();
    ipcRenderer.on("aurora:shown", fn);
    return () => ipcRenderer.removeListener("aurora:shown", fn);
  },
});
