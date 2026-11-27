import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { restoreCookies } from "./cookieAuth.js";
import { startYtDlpMaintenance } from "./ytdlp.js";

const config = loadConfig();
// Restore saved cookies BEFORE accepting requests, so the first browse of the
// YouTube Music root isn't served (and cached by the web) as anonymous.
await restoreCookies();
const server = createServer(config);
// Streams resolve through yt-dlp: log its version, keep it updated if configured.
startYtDlpMaintenance();

server.listen(config.port, config.host, () => {
  console.log(`[ytmusic-smapi] listening on http://${config.host}:${config.port}`);
});

const shutdown = (signal: string) => {
  console.log(`[ytmusic-smapi] ${signal} — shutting down`);
  // Docker starts the new container only once this one is gone: drop open streams now.
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
