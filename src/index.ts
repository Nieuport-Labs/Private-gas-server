import { buildServer } from "./server.js";
import { config } from "./config.js";
import { startAutoUnwrapJob } from "./autoUnwrap.js";
import { initWallet, isWalletConfigured } from "./wallet.js";

// Decrypts the stored provider key into memory (or adopts one from PROVIDER_MNEMONIC on first
// boot). Deliberately does not throw when there is no wallet yet: a fresh deployment is expected
// to start empty and have one generated from the dashboard.
initWallet();

const app = buildServer();

if (!isWalletConfigured()) {
  app.log.warn("no provider wallet configured — open the dashboard to generate or import one");
}

app.listen({ port: config.port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// Only started for the actual running server, not when server.ts is imported by a test —
// buildServer() alone must not have side effects like broadcasting transactions.
startAutoUnwrapJob();
