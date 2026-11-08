// UI-only preferences (kept in this browser, not on the backend)
const JUMP_KEY = "aurora.jumpConsole";

// Jump to the Console tab when a command or tool runs. On by default, also for auto-runs.
export const jumpToConsole = () => {
  try { return localStorage.getItem(JUMP_KEY) !== "0"; } catch { return true; }
};
export const setJumpToConsole = (on) => {
  try { localStorage.setItem(JUMP_KEY, on ? "1" : "0"); } catch {}
};

// Island opacity (0.4 = very see-through ... 1 = solid). Drives --alpha in styles.css.
const OPACITY_KEY = "aurora.opacity";
export const MIN_OPACITY = 0.4;
export const DEFAULT_OPACITY = 0.72;

export const getOpacity = () => {
  try {
    const v = parseFloat(localStorage.getItem(OPACITY_KEY));
    if (v >= MIN_OPACITY && v <= 1) return v;
  } catch {}
  return DEFAULT_OPACITY;
};
export const applyOpacity = (v) => document.documentElement.style.setProperty("--alpha", String(v));
export const saveOpacity = (v) => {
  try { localStorage.setItem(OPACITY_KEY, String(v)); } catch {}
};
