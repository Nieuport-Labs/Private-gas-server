// Verifies GET /status against a running server: shape of the response, CORS header, and that
// the reported balances match on-chain reality (via the same getProviderBalances() the endpoint
// itself calls — this is a shape/wiring check, not a redundant balance computation).
//
// Usage: start the server first (`npm run dev`), then run this against it.
import { getProviderBalances } from "../chain.js";

const BASE_URL = process.env.PROVIDER_URL ?? "http://localhost:8787";

async function main() {
  const res = await fetch(`${BASE_URL}/status`);
  if (!res.ok) throw new Error(`GET /status failed: HTTP ${res.status}`);
  const cors = res.headers.get("access-control-allow-origin");
  if (cors !== "*") throw new Error(`FAILED: expected CORS header "*", got ${cors}`);

  const status = await res.json();
  console.log("GET /status:", status);

  for (const field of ["providerAddress", "balances", "config"]) {
    if (!(field in status)) throw new Error(`FAILED: response missing "${field}"`);
  }
  if (typeof status.balances.uscrt !== "string" || typeof status.balances.sscrt !== "string") {
    throw new Error("FAILED: balances.uscrt/sscrt must be strings");
  }
  if (typeof status.config.feeMarkupPercent !== "number") {
    throw new Error("FAILED: config.feeMarkupPercent must be a number");
  }

  const actual = await getProviderBalances();
  if (status.balances.uscrt !== actual.uscrt || status.balances.sscrt !== actual.sscrt) {
    throw new Error(
      `FAILED: /status balances (${JSON.stringify(status.balances)}) don't match on-chain reality (${JSON.stringify(actual)})`,
    );
  }

  const homepage = await fetch(`${BASE_URL}/`);
  const html = await homepage.text();
  if (!homepage.ok || !html.includes("sSCRT gas provider")) {
    throw new Error("FAILED: GET / did not return the dashboard page");
  }

  console.log("OK: /status shape, CORS header, and balances all check out; GET / serves the dashboard.");
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
