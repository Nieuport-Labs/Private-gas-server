# Deploying the sSCRT gas provider

This walks through taking the server from "works on the local devnet" to "running on mainnet,
reachable over the internet" — on your own **ZimaOS** home server instead of a rented VPS.
Several steps here are things you need to do yourself — installing the app, moving real money,
and generating/backing up the provider's private key are all outside what this assistant will
do on your behalf; the commands are provided for you to run.

## Why ZimaOS instead of a VPS

We went through Oracle Cloud Always Free (account verification failed), Azure for Students
(activated fine, but VM creation was blocked by subscription-level region/SKU quota
restrictions), and Contabo (decent value but mixed reliability reputation) — and decided instead
to skip renting a VPS entirely. You already have a ZimaOS box at home; this server's actual load
(~1 tx/minute, a small Node process + SQLite) is trivial for it, and running it there means:

- No monthly VPS bill, no provider account to create, no credit-quota surprises.
- ZimaOS is Docker-based (built on the same app model as CasaOS), so deployment is a container,
  not a bare-metal systemd/apt setup.
- Public reachability comes from a **VPN tunnel to a relay** (Tailscale Funnel, see step 4) rather
  than opening a port on your home router — no port-forwarding, no exposing your home IP directly,
  and free TLS without running Caddy/certbot yourself.

The trade-off, stated plainly: your home internet connection's uptime and upload bandwidth become
part of this service's reliability (a VPS in a datacenter has better guarantees on both). Fine for
now while testing/low traffic; revisit if this ever needs production-grade SLA.

## 1. Local test first (before anything is exposed publicly)

Do this on any machine with Docker (your dev machine or directly on ZimaOS via SSH) before
touching ZimaOS's app UI, so you're debugging a normal Docker Compose stack, not a NAS app panel.

```bash
cd provider-service
cp .env.example .env
```

Fill in `.env` for a **local mainnet test** run (same file will be reused for the real deploy):
see step 3 below for the field-by-field guidance — do that section first if you haven't, then
come back here.

```bash
docker compose build
docker compose up -d
docker compose logs -f
```

Confirm from the same machine:

```bash
curl http://localhost:8787/health
curl http://localhost:8787/status
```

Open `http://localhost:8787/` in a browser — the dashboard should show the provider address and
(once funded, step 6) its balances. Run the existing smoke scripts against this local container
before moving on (see step 8) — cheaper to catch problems here than after exposing it.

## 2. Move the container to ZimaOS

If you built/tested on a different machine, get the code onto ZimaOS instead of copying images
around — simpler and matches how you'll update it later:

```bash
ssh <zimaos-user>@<zimaos-host>
git clone <your repo URL>
cd <repo>/provider-service
```

ZimaOS exposes a Docker Compose / "Custom Install" option in its app store UI, or you can just use
the CLI over SSH — both work since this is a plain `docker-compose.yml`. CLI is simpler for a
service like this with an `.env` file and a bind-mounted data directory:

```bash
mkdir -p data
cp .env.example .env
# fill in .env as below (or scp the one you already configured in step 1)
docker compose up -d --build
```

The compose file bind-mounts `./data` for the SQLite file and reads `.env` directly — no ZimaOS-
specific config needed beyond having Docker Compose available, which ZimaOS ships with.

## 3. Configure `.env`

```bash
chmod 600 .env
```

Fill in every field — several have **no safe default** and need a deliberate decision, not a
copy-paste:

- **`PROVIDER_MNEMONIC`** — generate this **yourself, in your own terminal** (not pasted through
  any assistant), so the mnemonic never leaves your control:

  ```bash
  node -e "const {Wallet}=require('secretjs'); const w=new Wallet(); console.log('address:', w.address); console.log('mnemonic:', w.mnemonic);"
  ```

  (Run from inside `provider-service/` with `node_modules` installed, or in the build stage of
  the container — `docker compose run --rm sscrt-provider node -e "..."` works too.) Write the
  mnemonic down somewhere durable and offline (password manager, paper backup). This must be a
  **brand-new wallet** — never the devnet throwaway mnemonic, never a personal wallet.

- **`NATIVE_GAS_PRICE_USCRT`** — this is the one that actually needs research before you commit to
  it, not a number to guess. Mainnet validators each set their own `min_gas_price`; there is no
  single official value. `0.0125uscrt` is described as the tier supported by 40%+ of validators as
  of the last check — doubling it (`0.025`) buys headroom against inclusion failures without
  materially changing what users pay. **Verify current guidance** (the Cosmos chain registry, or
  Secret Network's Discord/validator channels) before launch, and re-check periodically — this is
  exactly the kind of number that drifts and quietly breaks things if left stale.
- **`LCD_URL` / `RPC_URL`** — a public endpoint to start, with a plan to move to a dedicated/paid
  endpoint or your own node once traffic justifies it (a free public endpoint can rate-limit you,
  and this server's reliability depends entirely on its RPC endpoint being up). Verified working
  2026-09-17: `https://secretnetwork-api.lavenderfive.com:443` (LCD),
  `https://secretnetwork-rpc.lavenderfive.com:443` (RPC).

  Before trusting any other endpoint, check that it serves the enclave IO key, which `secretjs`
  needs for *every* encrypted contract query (balances via permit, whitelisted contract calls):

  ```bash
  curl "$LCD_URL/registration/v1beta1/tx-key"   # expect {"key":"..."}
  ```

  That exact path is the one `secretjs` calls. Don't test `/reg/consensus-io-exchange-pubkey` —
  it is a legacy path that returns `501 Not Implemented` on endpoints that are otherwise perfectly
  fine, which is actively misleading. Also don't trust the Cosmos chain-registry's list blindly:
  its Secret Saturn entries (`lcd.mainnet.secretsaturn.net`) were already dead (NXDOMAIN) when
  checked on 2026-09-17.
- **`SSCRT_CONTRACT`** — `secret1k0jntykt7e4g3y88ltc60czgjuqdy4c9e8fzek`, verified live on mainnet
  as of 2026-09-17 (label `sscrt`, code_id `2280`). The contract's *code hash* is never hardcoded
  anywhere in this codebase — `chain.ts`'s `getSscrtCodeHash()` resolves it fresh from the chain
  every time, which matters: this contract has already migrated at least once since its original
  2021 deployment, and a stale hardcoded hash would silently break every encrypted query.
- **`GRANT_SPEND_LIMIT_USCRT`**, **`AUTO_UNWRAP_THRESHOLD_USCRT`**, **`FEE_MARKUP_PERCENT`** — the
  devnet defaults are placeholders sized for testing, not a considered mainnet economic policy.
  Decide what spend limit per user, unwrap threshold, and margin actually make sense at the scale
  you're operating.

Leave `DB_PATH` and `PORT` alone — `docker-compose.yml` already sets those to match the container
(`/data/provider.sqlite3`, `8787`).

## 4. Expose it publicly — Tailscale Funnel (no port-forward, free TLS)

This replaces the VPS approach's "point a domain at a public IP + run Caddy for Let's Encrypt"
step. Tailscale Funnel runs a public HTTPS relay to a private machine over your existing
[Tailscale](https://tailscale.com) VPN mesh — free tier covers this, no card required, and your
home router's firewall never needs a port opened.

1. Install Tailscale on the ZimaOS host (either as a ZimaOS app, if listed in its app store, or
   the standard Linux install script over SSH):

   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up
   ```

   Follow the printed URL to authenticate the machine to your Tailscale account (creates one free
   if you don't have one).

2. Enable HTTPS certs for your tailnet (one-time, in the [Tailscale admin
   console](https://login.tailscale.com/admin/dns) → DNS → enable HTTPS).

3. Turn on Funnel for this port, pointing at the container (which is bound to `8787` on the host
   via `docker-compose.yml`):

   ```bash
   sudo tailscale funnel 8787 on
   ```

   Tailscale prints a public URL, something like `https://<machine-name>.<tailnet>.ts.net` — this
   is now internet-reachable, TLS-terminated by Tailscale, proxied straight to your container. No
   Caddy, no certbot, no A record to manage.

4. Confirm from any machine **not** on your Tailscale network (e.g. your phone on mobile data):

   ```bash
   curl https://<machine-name>.<tailnet>.ts.net/health
   curl https://<machine-name>.<tailnet>.ts.net/status
   ```

Funnel has a bandwidth ceiling on the free tier (generous for ~1 tx/minute JSON traffic, not for
serving large files) — fine for this server's actual payload sizes. If you later want a real
custom domain instead of the `ts.net` one, Tailscale Funnel supports that too, or you can put
Cloudflare Tunnel in front instead using the same "no open port" model — swap later without
changing anything about the container itself.

## 5. Run it as a persistent service

`docker-compose.yml` already has `restart: unless-stopped`, so the container survives a ZimaOS
reboot or a crash without any systemd unit needed — Docker's own restart policy covers what
`sscrt-provider.service` did on a bare VPS. (`deploy/sscrt-provider.service` and `deploy/Caddyfile`
in this repo are now unused leftovers from the VPS path — harmless to keep for reference, or
delete them if you'd rather not carry dead config around.)

Check it's set to start on boot along with Docker itself:

```bash
sudo systemctl is-enabled docker   # should already be "enabled" on ZimaOS
```

## 6. Fund the provider wallet

Send real SCRT to the address from step 3, **using your own wallet** — this assistant will not
execute a transfer on your behalf. Size the initial amount for: (a) enough native SCRT to cover
grants for your expected early traffic, and (b) the plan's hot/cold split — keep only an
operational reserve here (days to weeks of expected spend), with the bulk held separately and
topped up periodically, not the whole treasury sitting on this server's key.

## 7. Calibrate gas — against mainnet, not devnet

The devnet's calibration numbers (in this repo's history, in smoke test output) are **not** valid
for mainnet — gas costs can shift with chain version and contract state. Run for real, once,
before taking any live traffic:

```bash
docker compose exec sscrt-provider npm run calibrate:payment
```

If you're enabling any whitelisted contract (`ALLOWED_CONTRACT_ADDRESSES`), calibrate each one
too, with a sample message shaped like the **most expensive** call you intend to allow on it:

```bash
docker compose exec sscrt-provider npm run calibrate:contract -- <contractAddress> "<execMsgJson>" 10
```

Both write into the SQLite DB under the bind-mounted `./data` directory — back this up after
calibrating (see "Operations" → Backups, below).

## 8. Go-live smoke test — small amounts first

Before pointing any real app at it, run the existing smoke scripts against mainnet with a
throwaway small amount. They read config via `process.env`, so run them inside the container
(where `.env` is already loaded) or export the same values locally:

```bash
docker compose exec sscrt-provider npx tsx src/scripts/smoke-submit.ts
```

or, for the HTTP-layer ones, against the public Funnel URL from your own machine:

```bash
PROVIDER_URL=https://<machine-name>.<tailnet>.ts.net npm run smoke:http
```

Confirm: onboarding creates a real grant, a quote for a small `MsgSend` prices sensibly, submit
lands with `code 0`, and the provider is reimbursed the expected sSCRT amount — on mainnet, with
real (small) money, before trusting it with anything larger.

## 9. What's still not here

- **Client/dApp integration** — this deploys the *server*. Nothing calls it yet until a frontend
  (or another backend) is wired up to `/onboard`, `/quote`, `/submit` — that's the plan's
  explicitly separate next phase.
- **Accounting/monitoring dashboards beyond `/status`** — `/status` covers balances and config;
  deeper accounting (spend-vs-reimbursement over time, alerting) isn't built.
- **Grant lifecycle management** (renewing/revoking expiring grants automatically) — not built;
  grants currently just expire per `GRANT_EXPIRY_SECONDS` and aren't renewed.

## Operations

- **Updating**: `git pull && docker compose up -d --build` (from `provider-service/` on ZimaOS).
- **Logs**: `docker compose logs -f sscrt-provider`.
- **Backups**: back up the `./data` directory periodically — it holds grants, permits, gas
  calibration, and the quote/submit/auto-unwrap history. Losing it doesn't lose funds (on-chain
  state is authoritative), but does lose calibration (re-run step 7) and per-user grant
  bookkeeping. If ZimaOS has a snapshot/backup feature for app data volumes, point it at this
  directory.
- **Rotating the provider key**: generate a new wallet (step 3), fund it, update `.env`, then
  `docker compose up -d --build`. Existing grants stay valid under the old granter until they
  expire; new grants use the new key. Revoke the old key's remaining allowances on-chain if
  retiring it immediately matters more than a clean cutover.
- **Home network dependency**: unlike a VPS, this server's uptime now depends on your home
  internet connection and the ZimaOS box staying powered on. Worth knowing before treating this
  as production-grade — fine for testing and modest traffic, worth revisiting (real VPS, or a
  colocated box) if this ever needs to guarantee uptime.
