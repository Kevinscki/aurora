# Aurora: restore the look you asked for, add transparency

Unzip over your project (same folder layout), then `cd electron && npm start`
(it rebuilds the UI itself). Touches only these files:

    frontend/src/App.jsx  styles.css  controls.jsx  prefs.js  main.jsx
    electron/main.js      frontend/dist/*

## What was removed (ChatGPT's last two rounds, not in your readme.txt)
- "Workspace reimagining": the left sidebar, the big workspace header, the new colours and 7px corners.
- "Liquid-glass shell": the floating green/blue orbs, the gradient and grid behind the island, the heavy blur.

## What was kept (everything from your readme.txt list)
- Dark green theme, 2px straight corners, monospace font, green island border.
- Liquid spring expand/contract animation.
- Minimize button + system tray, Esc only tucks the island away.
- Custom dropdowns (native ones opened behind the always-on-top window).
- Text-colour fixes, and all the earlier backend/voice/MCP/auto-run work.

## Transparency
- **Controls tab > Appearance > Window transparency**: 40% to 100% opaque, live, remembered. Default 80%.
  100% is solid, exactly like before. Dim text brightens and gets a soft shadow as it gets more see-through.
- The Electron window itself is truly transparent (that came from dropping `--disable-gpu`, which makes
  transparent windows render with a black box on Linux). That change from ChatGPT is kept.
- Menus/dropdowns stay opaque.

## Small tidy in electron/main.js
- Removed duplicated switch lines; the venv environment is only set when that venv is actually used.
