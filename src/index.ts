import { buildServer } from "./server.js";
import { config } from "./config.js";
import { startAutoUnwrapJob } from "./autoUnwrap.js";

const app = buildServer();

app.listen({ port: config.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// Only started for the actual running server, not when server.ts is imported by a test —
// buildServer() alone must not have side effects like broadcasting transactions.
startAutoUnwrapJob();
