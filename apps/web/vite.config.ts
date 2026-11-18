import { execSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

// Which build this is (src/buildInfo.ts). The Docker build has no .git, so the commit
// comes from Coolify's SOURCE_COMMIT when it passes one, else from git when there is one.
function gitCommit(): string | undefined {
  const fromCoolify = process.env.SOURCE_COMMIT?.trim();
  if (fromCoolify && fromCoolify !== "HEAD") return fromCoolify.slice(0, 7);
  try {
    return execSync("git rev-parse --short=7 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
}
const build = { time: new Date().toISOString(), commit: gitCommit() };

// Also written to /build.json, so an open app can see whether the server has a newer build.
function buildJson(): Plugin {
  return {
    name: "misonos-build-json",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "build.json", source: JSON.stringify(build) });
    }
  };
}

export default defineConfig({
  define: {
    __MISONOS_BUILD__: JSON.stringify(build)
  },
  plugins: [
    react(),
    buildJson(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.png", "apple-touch-icon.png"],
      // Installable in the dev server too, so add-to-home-screen works over Tailscale
      // without a separate build step.
      devOptions: { enabled: true, type: "module" },
      manifest: {
        name: "MiSonos",
        short_name: "MiSonos",
        description: "Sonos controller",
        theme_color: "#141716",
        background_color: "#141716",
        display: "standalone",
        orientation: "portrait",
        icons: [
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
        ]
      },
      workbox: {
        // Never let the SW intercept bridge calls — SSE (/api/events) and dynamic
        // endpoints must always hit the network. The Cloudflare Access login has to
        // reach the network too: `/?signin` is where the app sends an expired session
        // (accessSession.ts) and `/cdn-cgi/` is Access's callback that sets the cookie.
        navigateFallbackDenylist: [/^\/api\//, /^\/cdn-cgi\//, /^\/\?signin(?:[=&]|$)/],
        // Quiet the verbose dev-mode console logging ("No route found" / "Precaching
        // did not find a match") that fired for every uncached bridge call.
        disableDevLogs: true,
        runtimeCaching: [
          {
            // Album art is keyed by the encoded upstream URL, so it's safe to cache.
            // Same-origin only — art from a switched-to (cross-origin) backend bypasses
            // the SW and loads directly, like the rest of that host's API.
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname === "/api/art",
            handler: "CacheFirst",
            options: {
              cacheName: "album-art",
              expiration: { maxEntries: 200, maxAgeSeconds: 7 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            // Same-origin bridge calls always hit the network and are never cached.
            // A registered route stops workbox falling through to "No route found".
            // Cross-origin calls (to a switched-to backend) and the SSE stream are left
            // to bypass the SW entirely so they go straight to the target host.
            urlPattern: ({ url, sameOrigin }) => sameOrigin && url.pathname.startsWith("/api/") && url.pathname !== "/api/events",
            handler: "NetworkOnly"
          }
        ]
      }
    })
  ],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4317"
    },
    allowedHosts: [".ts.net", "localhost", "127.0.0.1"]
  },
  preview: {
    proxy: {
      "/api": "http://127.0.0.1:4317"
    },
    allowedHosts: [".ts.net", "localhost", "127.0.0.1"]
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"]
  }
});
