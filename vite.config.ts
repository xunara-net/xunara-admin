import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// The admin console talks to the platform API on the same origin. In
// development the control plane is proxied, exactly like the deployment's
// reverse proxy does, so the bearer token never travels cross-origin.
const controlPlane = process.env.XUNARA_CONTROL_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  base: "/admin/",
  server: {
    port: 5174,
    proxy: {
      "/api": { target: controlPlane, changeOrigin: false },
    },
  },
});
