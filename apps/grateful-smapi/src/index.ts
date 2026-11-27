import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig();
const server = createServer(config);

server.listen(config.port, config.host, () => {
  console.log(`[grateful-smapi] listening on http://${config.host}:${config.port}`);
  console.log(`[grateful-smapi] db: ${config.dbPath}`);
  console.log(`[grateful-smapi] register on a speaker at http://<speaker-ip>:1400/customsd.htm`);
});

const shutdown = (signal: string) => {
  console.log(`[grateful-smapi] ${signal} — shutting down`);
  // Docker starts the new container only once this one is gone: drop open streams now.
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
