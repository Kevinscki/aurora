import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server (npm run dev): forwards everything Aurora's backend serves.
const backend = "127.0.0.1:8765";
const http = (path) => [path, `http://${backend}`];
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: `ws://${backend}`, ws: true }, // /ws/aurora and /ws/live_audio
      ...Object.fromEntries(["/history", "/run", "/settings", "/voice", "/speech", "/memory", "/skills", "/mcp", "/llm"].map(http)),
    },
  },
});
