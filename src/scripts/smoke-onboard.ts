// End-to-end smoke test for the onboarding module against the local devnet: a brand-new
// address (generated here, never touched before) gets a fee grant from the provider's own
// signer, and a SNIP-24 balance permit is captured and stored — using the actual server
// code path (onboardUser), not hand-rolled CLI calls like step 0's manual verification.
import { Wallet, SecretNetworkClient } from "secretjs";
import { onboardUser, getStoredGrant, getStoredPermit } from "../onboarding.js";
import { getAccount, getProviderAddress } from "../chain.js";
import { config } from "../config.js";

async function main() {
  const wallet = new Wallet(); // fresh random mnemonic, never used before
  const address = wallet.address;
  console.log("brand-new address:", address);

  const before = await getAccount(address);
  console.log("account before onboarding (expect exists=false):", before);
  if (before.exists) throw new Error("test setup invalid: address already has an account");

  // The user's own client, used only to sign the offline permit — never to send SCRT.
  const userClient = new SecretNetworkClient({
    url: config.lcdUrl,
    chainId: config.chainId,
    wallet,
    walletAddress: address,
  });
  const permit = await userClient.utils.accessControl.permit.sign(
    address,
    config.chainId,
    "onboarding-smoke-test",
    [config.sscrtContract],
    ["balance"],
    false,
  );

  console.log("provider address (granter):", getProviderAddress());
  const result = await onboardUser(address, permit);
  console.log("onboard result:", result);

  const after = await getAccount(address);
  console.log("account after onboarding (expect exists=true, sequence=0):", after);
  if (!after.exists) throw new Error("FAILED: account still does not exist after grant");
  if (after.sequence !== 0) throw new Error(`FAILED: expected sequence 0, got ${after.sequence}`);

  const storedGrant = getStoredGrant(address);
  const storedPermit = getStoredPermit(address);
  console.log("stored grant row:", storedGrant);
  console.log("stored permit present:", !!storedPermit);
  if (!storedGrant || !storedPermit) throw new Error("FAILED: onboarding did not persist state");

  console.log("OK: onboarding smoke test passed end to end");
}

main().catch((err) => {
  console.error("SMOKE TEST FAILED:", err);
  process.exit(1);
});
