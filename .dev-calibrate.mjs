// Calibrates a whitelisted contract's gas against the local .dev instance.
//
// Exists because the env matters more than the arguments here: the calibration is written to a
// database, and run with the defaults it would write to ./provider.sqlite3 while the local server
// reads ./.dev/dev.sqlite3 — a constant recorded where nothing will ever read it, with real
// transactions paid for. This mirrors .dev-serve.mjs exactly so both point at the same store.
//
// Usage: npx tsx .dev-calibrate.mjs <contractAddress> <execMsgJson> [sampleCount]
//
// Stop the local server first if you can. It signs with the same account, and two processes
// broadcasting from one account race on the sequence number.
Object.assign(process.env, {
  NODE_ENV: "production",
  ADMIN_PASSWORD: "",
  PROVIDER_MNEMONIC: "",
  DB_PATH: "./.dev/dev.sqlite3",
  CHAIN_ID: "secret-4",
  LCD_URL: process.env.LCD_URL ?? "https://lcd.secret.mainnet.secret3.dev",
  SSCRT_CONTRACT: "secret1k0jntykt7e4g3y88ltc60czgjuqdy4c9e8fzek",
  NATIVE_GAS_PRICE_USCRT: process.env.NATIVE_GAS_PRICE_USCRT ?? "0.1",
});

const contractAddress = process.argv[2];
const execMsgJson = process.argv[3];
const sampleCount = Number(process.argv[4] ?? 5);

if (!contractAddress || !execMsgJson) {
  console.error("usage: npx tsx .dev-calibrate.mjs <contractAddress> <execMsgJson> [sampleCount]");
  process.exit(1);
}

let execMsg;
try {
  execMsg = JSON.parse(execMsgJson);
} catch (err) {
  console.error(`the exec message is not valid JSON: ${err.message}`);
  process.exit(1);
}

const { unlockWithKeyfile } = await import("./src/secretStore.ts");
const { initWallet, getProviderAddress } = await import("./src/wallet.ts");
unlockWithKeyfile();
initWallet();

const { calibrateContractGas } = await import("./src/maintenance.ts");

console.log(`calibrating ${contractAddress} as ${getProviderAddress()} — ${sampleCount} real transactions`);
calibrateContractGas(contractAddress, execMsg, sampleCount, (m) => console.log(m))
  .then((r) => console.log(`min=${r.min} max=${r.max} avg=${r.avg}`))
  .catch((err) => {
    console.error("CALIBRATION FAILED:", err.message ?? err);
    process.exit(1);
  });
