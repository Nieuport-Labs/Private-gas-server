import { buildServer } from "./server.js";
import { config } from "./config.js";
import { startAutoUnwrapJob } from "./autoUnwrap.js";
import { initWallet, isWalletConfigured } from "./wallet.js";
import { isSetUp, unlockWithKeyfile, setup } from "./secretStore.js";
import { bootstrapFromEnv } from "./bootstrap.js";

bootstrapFromEnv({ isSetUp, setup });

// Unlocks the seed from the keyfile next to the database, so a restart resumes sponsoring with
// nobody present. Failure here is not fatal: the operator can still unlock by signing in.
unlockWithKeyfile();
initWallet();

const app = buildServer();

if (!isSetUp()) {
  app.log.warn("first-run setup pending — open the dashboard to set an admin password");
} else if (!isWalletConfigured()) {
  app.log.warn("no provider wallet configured — open the dashboard to generate or import one");
}

app.listen({ port: config.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// Only started for the actual running server, not when server.ts is imported by a test —
// buildServer() alone must not have side effects like broadcasting transactions.
startAutoUnwrapJob();
