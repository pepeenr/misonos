import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig();
const server = createServer(config);

server.listen(config.port, config.host, () => {
  console.log(`[phish-smapi] listening on http://${config.host}:${config.port}`);
  console.log(`[phish-smapi] phish.in api: ${config.apiBase}${config.apiKey ? " (with bearer token)" : ""}`);
});

const shutdown = (signal: string) => {
  console.log(`[phish-smapi] ${signal} — shutting down`);
  // Docker starts the new container only once this one is gone: drop open streams now.
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
