import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static React 19 SPA. In production the event-viewer plugin
// (lib/plugins/event-viewer.ts) serves dist/, falls back to index.html for
// client-routed paths, and proxies /api/* and /ws to the main server.
//
// In dev (`bun run dev`), point /api and /ws at a locally running instance so
// the dev server behaves like production. The event-viewer (port 8080) hosts
// /ws + /api/events and proxies the rest to the main app — so proxying both to
// 8080 mirrors the production origin exactly.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist" },
  // Keep the Astro-era `PUBLIC_*` convention for build-time public env vars
  // (e.g. PUBLIC_LANGFUSE_URL in SkillTrace) alongside Vite's default VITE_*,
  // so existing deploy env doesn't need renaming.
  envPrefix: ["VITE_", "PUBLIC_"],
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
