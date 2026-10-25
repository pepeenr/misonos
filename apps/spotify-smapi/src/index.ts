import { readSavedClientId } from "./clientId.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

const config = loadConfig();
const saved = await readSavedClientId(config.clientIdPath);
const server = createServer(config, saved);

server.listen(config.port, config.host, () => {
  console.log(`[spotify-smapi] listening on http://${config.host}:${config.port}`);
  if (saved ?? config.clientId) {
    console.log(`[spotify-smapi] Client ID from ${saved ? `Settings (${config.clientIdPath})` : "env"}; token file: ${config.tokenPath}`);
    if (config.redirectUri) console.log(`[spotify-smapi] redirect URI: ${config.redirectUri}`);
  } else {
    console.log("[spotify-smapi] not configured — source hidden until a Client ID is saved in Settings or MISONOS_SPOTIFY_CLIENT_ID is set");
  }
});

const shutdown = (signal: string) => {
  console.log(`[spotify-smapi] ${signal} — shutting down`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
