// Optional headless setup from the environment.
//
// The intended path is first-run setup in the dashboard, which keeps the password out of the
// container's configuration entirely. ADMIN_PASSWORD remains supported for the cases where a
// browser is not in the loop — CI, the devnet, an automated rebuild — and only does anything on
// a store that has never been set up. It never overwrites an existing password.
import { config } from "./config.js";

export function bootstrapFromEnv(store: { isSetUp: () => boolean; setup: (password: string) => void }): void {
  if (store.isSetUp() || !config.adminPassword) return;
  store.setup(config.adminPassword);
}
