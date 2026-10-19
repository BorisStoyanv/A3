import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      [
        "/session",
        "/profile",
        "/webhooks",
        "/healthz",
        "/auth",
        "/logout",
        "/billing",
        "/github",
        "/gitlab",
        "/templates",
        "/projects",
        "/tenants",
        "/deploy",
        "/notifications",
        "/admin",
        "/routing",
        "/eject",
      ].map((prefix) => [prefix, "http://127.0.0.1:3000"]),
    ),
  },
});
