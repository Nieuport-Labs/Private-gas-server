import { buildServer } from "./server.js";
import { config } from "./config.js";
import { startAutoUnwrapJob } from "./autoUnwrap.js";
import { initWallet, isWalletConfigured } from "./wallet.js";
import { isSetUp, unlockWithKeyfile, setup } from "./secretStore.js";
import { bootstrapFromEnv } from "./bootstrap.js";
import { deliverPending } from "./creditDelivery.js";
import { pruneExpired } from "./dataPurge.js";

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

// A purchase that was paid for and not delivered is money owed. A restart is one of the ways
// that happens, so the first thing a fresh process does is look for one, and it keeps looking:
// the endpoint being down for a minute must not turn into a buyer never getting their credits.
const DELIVERY_SWEEP_MS = 60_000;
void deliverPending().catch((err) => app.log.error({ err }, "credit delivery sweep failed at boot"));
setInterval(() => {
  void deliverPending().catch((err) => app.log.error({ err }, "credit delivery sweep failed"));
}, DELIVERY_SWEEP_MS).unref();

// Retention. The server stops needing a quote long before anything deletes it, and the gap is
// where a record of who sent what to whom accumulates for no reason.
const PRUNE_INTERVAL_MS = 15 * 60_000;
setInterval(() => {
  const pruned = pruneExpired();
  if (pruned.quotes > 0 || pruned.grants > 0) app.log.info(pruned, "pruned expired rows");
}, PRUNE_INTERVAL_MS).unref();
