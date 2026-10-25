import { loadConfig, serverFromConfig } from "./config.js";
import { readSavedLogin } from "./login.js";
import { createServer } from "./server.js";

const config = loadConfig();
const savedLogin = await readSavedLogin(config.loginPath);
const server = createServer(config, savedLogin);

server.listen(config.port, config.host, () => {
  console.log(`[navidrome-smapi] listening on http://${config.host}:${config.port}`);
  const navidrome = savedLogin ?? serverFromConfig(config);
  if (navidrome) {
    const origin = savedLogin ? `saved login (${config.loginPath})` : "env";
    console.log(`[navidrome-smapi] server: ${navidrome.serverUrl} as ${navidrome.username}, from ${origin}`);
    console.log(`[navidrome-smapi] non-native formats → ${config.transcodeFormat} @ ${config.maxBitRate} kbps`);
  } else {
    console.log("[navidrome-smapi] not configured — source hidden until you log in from Settings or set MISONOS_NAVIDROME_SERVER_URL/_USER/_PASSWORD");
  }
});

const shutdown = (signal: string) => {
  console.log(`[navidrome-smapi] ${signal} — shutting down`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
