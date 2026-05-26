import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiHost = process.env.HIVE_HOST ?? "127.0.0.1";
const apiPort = process.env.HIVE_PORT ?? "9990";
const apiTarget = `http://${apiHost}:${apiPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/trpc": apiTarget,
      "/api": apiTarget
    }
  }
});
