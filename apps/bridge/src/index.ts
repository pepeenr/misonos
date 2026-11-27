import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { SonosService } from "./sonosService.js";
import { createStore } from "./store/index.js";

const config = loadConfig();
const store = await createStore(config.dbPath); // runs migrateToLatest(); throws (fails fast) on a broken DB
const service = new SonosService(config);
const server = createServer(service, config, store);

server.listen(config.port, config.host, () => {
  console.log(`MiSonos bridge listening on http://${config.host}:${config.port}`);
  console.log(`[bridge] store: ${config.dbPath}`);
});

// Docker stops the old container before it starts the new one, so every second spent
// here is a second the speakers and apps can't reach MiSonos. Don't wait for the open
// apps' event streams (they never end) or a speaker's song: drop them and go.
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  server.close();
  server.closeAllConnections();
  setTimeout(() => process.exit(0), 2000).unref();
  void store.close().catch(() => undefined).finally(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
