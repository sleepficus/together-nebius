import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  build: {
    outDir: "dist/client",
    // useProject lazily imports React at module top-level (TLA, es2022+).
    target: "es2022",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    fs: {strict:true,deny:['.env','.env.*','**/.git/**','**/.runtime/**','**/.private/**','*.{crt,pem,key}']},
    // Loopback only: the proxied API holds owner authority and the dev
    // server is a local prototype surface, never a LAN service.
    host: "127.0.0.1",
    allowedHosts: ["localhost"],
    proxy: {
      "/api": process.env.TOGETHER_API_TARGET ?? "http://127.0.0.1:8937",
    },
    warmup: {
      clientFiles: ["./src/main.tsx"],
    },
  },
  plugins: [react()],
});
