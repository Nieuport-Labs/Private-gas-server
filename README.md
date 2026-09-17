# sSCRT Gas Provider

A gas-sponsorship server for [Secret Network](https://scrt.network). It lets a user pay
transaction fees in **sSCRT** (wrapped SCRT, a SNIP-20 token) instead of native SCRT, without any
change to the chain itself.

The user signs one ordinary Cosmos transaction containing two messages — their intended action
(a delegation, a vote, a bank send, a whitelisted contract call, …) and a payment to the provider
— with `fee.granter` pointed at the provider via [`x/feegrant`](https://docs.cosmos.network/main/build/modules/feegrant).
The provider covers the native gas fee up front and is reimbursed in sSCRT in the same
transaction. Because the user signs the action directly, delegations, votes, and every other
message type behave exactly as if the user had paid gas natively — there is no relayer or
forwarder contract standing in for them.

## How it works

```
User (Keplr)                          Provider server                     Secret Network
     │                                       │                                    │
     │  POST /onboard (SNIP-24 permit)       │                                    │
     ├──────────────────────────────────────►│  MsgGrantAllowance                 │
     │                                       ├───────────────────────────────────►│
     │                                       │                                    │
     │  POST /quote (intended action)        │  read balance (permit), simulate   │
     ├──────────────────────────────────────►│  gas, build unsigned tx            │
     │◄──────────────────────────────────────┤                                    │
     │  unsigned tx (action + payment)       │                                    │
     │                                       │                                    │
     │  sign locally, never sends the key    │                                    │
     │                                       │                                    │
     │  POST /submit (signed tx bytes)       │  re-check sequence & balance,      │
     ├──────────────────────────────────────►│  broadcast                         │
     │                                       ├───────────────────────────────────►│
```

Three endpoints carry this:

- **`POST /onboard`** — grants the user a scoped, expiring [`AllowedMsgAllowance`](https://docs.cosmos.network/main/build/modules/feegrant#msggrantallowance),
  limited to specific message types and a spend cap. Also registers the user's SNIP-24 permit,
  which the server needs to read their (private) sSCRT balance before issuing a quote.
- **`POST /quote`** — checks grant coverage and balance, estimates gas, and returns an unsigned
  `SignDoc` for the user's wallet to sign. Quotes are short-lived (`QUOTE_TTL_SECONDS`) and must
  be re-issued once expired, since the sequence number or balance they were built against can go
  stale.
- **`POST /submit`** — accepts the signed transaction bytes, re-verifies the sequence number and
  balance immediately before broadcasting, and submits. If anything has changed since the quote,
  it refuses rather than broadcast — the provider never pays for a transaction it didn't just
  re-check.

### Why gas estimation is split in two

Secret Network cannot simulate `MsgExecuteContract` at all — the message payload is client-side
encrypted, and the simulate endpoint has no transaction to encrypt against. So gas for any
contract call (the sSCRT payment message, and any whitelisted contract action) comes from a
periodically re-measured calibration constant per contract address, not from `simulate()`.
Native messages (`MsgSend`, `MsgDelegate`, `MsgVote`, …) are still simulated normally. The final
gas limit is the sum of both, plus a buffer.

### Provider's own reserves

The provider spends native SCRT on grants and is reimbursed in sSCRT, which otherwise just
accumulates. A background job (`autoUnwrap.ts`) periodically redeems accumulated sSCRT back to
native SCRT once it crosses a configurable threshold, closing the loop.

## Sponsorable actions

- Native message types: `MsgSend`, `MsgDelegate`, `MsgUndelegate`, `MsgBeginRedelegate`,
  `MsgVote` (configurable via `ALLOWED_MESSAGE_TYPES`).
- `MsgExecuteContract` calls against an operator-defined **contract whitelist**
  (`ALLOWED_CONTRACT_ADDRESSES`) — e.g. sponsoring gas for a DEX swap. Whitelisting is
  whole-contract, not per-entry-point, and each contract needs its own gas calibration
  (`npm run calibrate:contract`) before it will be quoted. The server sees the plaintext of a
  whitelisted call (it has to, to check the target address) and encrypts it itself before
  broadcast — the same trust boundary as the payment message.

## Quickstart

```bash
npm install
cp .env.example .env   # fill in values — see .env.example for what each one does
npm run dev
```

This starts the server against whatever chain `.env` points at (defaults to a local
[LocalSecret](https://docs.scrt.network/secret-network-documentation/development/tools-and-libraries/local-secret)
devnet). Visit `http://localhost:8787/` for the dashboard, or `GET /status` for the same data as
JSON.

### Docker

```bash
docker compose build
docker compose up -d
```

See [`Dockerfile`](./Dockerfile) and [`docker-compose.yml`](./docker-compose.yml).

### Deploying for real

See [`DEPLOY.md`](./DEPLOY.md) for a full mainnet deployment walkthrough — provisioning,
wallet generation, gas calibration, and going live behind a public URL, including a
self-hosted (ZimaOS + Tailscale Funnel) path that needs no VPS or open router port.

## Dashboard and admin access

`GET /` serves a dashboard that shows the provider's balances and lets the operator manage the
wallet and tune settings at runtime. It is gated by `ADMIN_PASSWORD`; the public API
(`/onboard`, `/quote`, `/submit`) and the client-facing part of `/status` are not, since dApp
users cannot hold the admin password.

- **Wallet**: generate a new provider wallet or import one from a seed phrase. A generated seed
  is displayed exactly once and is never readable back through any endpoint.
- **Settings**: fee markup, auto-unwrap (on/off and threshold), per-user grant spend limit and
  expiry, and the sponsored-contract whitelist — all editable without a restart.

`/status` returns the fee markup and provider address to anyone (a client needs both to build a
sponsored transaction), and adds balances, settings and auto-unwrap history only for a logged-in
operator.

### How the seed is stored

The mnemonic is encrypted with AES-256-GCM under a key derived from `ADMIN_PASSWORD` (scrypt) and
kept in the SQLite database, so it is not in the environment, the compose file, or `docker
inspect` output, and a stolen database file alone does not yield it. The server decrypts it at
boot without human involvement, which is what lets it restart unattended — and which also means
the honest limit of this scheme: an attacker with both the environment and the database can still
recover the seed. It is defence in depth and better key hygiene, not a vault.

Admin sessions are bearer tokens held in memory, so a restart signs the operator out. Tokens are
sent in an `Authorization` header rather than a cookie specifically because the public API is
CORS-open; a cookie combined with that would be a CSRF hole.

## Configuration

All configuration is environment variables — see [`.env.example`](./.env.example) for the full
list with defaults and explanations. Two have **no safe default** and must be set explicitly in
production: `ADMIN_PASSWORD` and `NATIVE_GAS_PRICE_USCRT`. `PROVIDER_MNEMONIC` is optional and
best left empty, so the wallet is created through the dashboard instead.

The settings listed above are environment variables only for their *initial* values; once changed
in the dashboard, the database is the source of truth.

## Development

```bash
npm run build        # tsc -p .
npx tsc --noEmit      # typecheck only
```

`src/scripts/` holds smoke tests and calibration scripts, each runnable directly with `npm run
<script-name>` (see `package.json`). They exercise the full onboard → quote → submit loop against
a real chain (devnet by default) — there is no mocked test suite, since the interesting failure
modes here are almost all about actual on-chain behavior (sequence races, simulate limitations,
fee mechanics) that a mock would hide.

## Status

This is the server half of a larger design (see the design notes referenced in the parent
repository). Not yet built: client/dApp integration (nothing calls `/onboard`, `/quote`, or
`/submit` yet beyond the smoke scripts), deeper accounting/alerting beyond `/status`, and
automatic grant renewal/revocation.

## Security notes

- The provider's signing key only ever signs its own transactions (`MsgGrantAllowance`, gas
  calibration probes, auto-unwrap) — it never signs a user's action. The user's action and
  payment are signed once, by the user, client-side.
- Every grant is scoped: a specific set of message types, a spend limit, and an expiry. There is
  no unrestricted grant.
- `/submit` re-verifies sequence number and balance immediately before broadcast. A stale or
  invalid quote is rejected pre-broadcast, so the provider never pays for a transaction whose
  preconditions have changed.
- The server holds no user private keys and never asks for one.
- The provider's own key is encrypted at rest and is never returned by any endpoint after the
  one-time reveal when it is generated.
