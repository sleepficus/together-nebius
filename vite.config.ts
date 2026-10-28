// Cloud wiring note: the hosted cloud worker serves the UI and /api/v1
// from the same origin, so no build-time API target is needed — the
// same-origin apiBase default in useProject is already correct. The dev
// proxy below stays local-preview only and is unchanged.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  build: {
    outDir: "dist/client",
    // useProject lazily imports React at module top-level (TLA, es2022+).
    target: "es2022",
  },
  optimizeDeps: { include: ["react", "react-dom/client"] },
  server: {
    fs: {strict:true,deny:['.env','.env.*','**/.git/**','**/.runtime/**','**/.private/**','*.{crt,pem,key}']},
    host: "127.0.0.1",
    allowedHosts: ["localhost"],
    proxy: { "/api": process.env.TOGETHER_API_TARGET ?? "http://127.0.0.1:8937" },
    warmup: { clientFiles: ["./src/main.tsx"] },
  },
  plugins: [react()],
});
