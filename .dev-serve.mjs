// Local server for hands-on testing. Mirrors src/index.ts's startup sequence exactly.
// Data lives in ./.dev so it never touches anything real.
Object.assign(process.env, {
  NODE_ENV: "production",
  ADMIN_PASSWORD: "",            // set the password in the browser, as on the real box
  PROVIDER_MNEMONIC: "",
  DB_PATH: "./.dev/dev.sqlite3",
  CHAIN_ID: "secret-4",
  LCD_URL: process.env.LCD_URL ?? "https://secretnetwork-api.lavenderfive.com:443",
  RPC_URL: process.env.RPC_URL ?? "https://secretnetwork-rpc.lavenderfive.com:443",
  SSCRT_CONTRACT: "secret1k0jntykt7e4g3y88ltc60czgjuqdy4c9e8fzek",
  NATIVE_GAS_PRICE_USCRT: "0.025",
  PORT: "8790",
});
const { isSetUp, unlockWithKeyfile } = await import("./src/secretStore.ts");
const { initWallet, isWalletConfigured } = await import("./src/wallet.ts");
const { buildServer } = await import("./src/server.ts");
unlockWithKeyfile();
initWallet();
const app = buildServer();
await app.listen({ port: 8790, host: "127.0.0.1" });
console.log(`ready on http://localhost:8790  (setup done: ${isSetUp()}, wallet: ${isWalletConfigured()})`);
