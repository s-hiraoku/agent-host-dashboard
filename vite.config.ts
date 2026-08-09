import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export function safeAgentHostTarget(rawTarget: string): string {
  const target = new URL(rawTarget);
  const loopback = target.hostname === "127.0.0.1" || target.hostname === "[::1]" || target.hostname === "localhost";
  if (
    !loopback ||
    (target.protocol !== "http:" && target.protocol !== "https:") ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  ) {
    throw new Error("AGENT_HOST_URL must be a loopback HTTP(S) URL without credentials, query parameters, or fragments.");
  }
  return target.toString();
}

export default defineConfig(() => {
  const target = safeAgentHostTarget(process.env.AGENT_HOST_URL ?? "http://127.0.0.1:4777");
  const token = process.env.AGENT_HOST_TOKEN;
  return {
    plugins: [react()],
    server: {
      proxy: {
        "/agent-host": {
          target,
          changeOrigin: false,
          rewrite: (path) => path.replace(/^\/agent-host/, ""),
          configure(proxy) {
            proxy.on("proxyReq", (request) => {
              if (token) request.setHeader("authorization", `Bearer ${token}`);
            });
          },
        },
      },
    },
  };
});
