# Running the provider in a confidential VM

Everything else this server does asks you to trust whoever runs it. The permit is deleted
because we say so. The balance is read once because we say so. Running inside an Intel TDX
confidential VM replaces some of that with something you can check: the hardware signs a
statement about the exact software image it booted, and the host — Phala included — cannot read
the memory or the disk of what is running.

**It replaces trust only if somebody verifies.** An attestation nobody checks is worth precisely
as much as a promise, so the last section here is the one that matters.

## What it protects, and what it does not

Protected, once deployed and verified:

- **The provider's mnemonic.** The largest secret here. The disk is encrypted with a key derived
  from the application and instance identity and released by KMS only after attestation, so the
  host cannot read it.
- **Users' permits**, for the minutes they exist. Same disk, same key.
- **What the code does.** The compose file below is hashed into the application's identity, so
  the running image cannot be swapped without the app id changing and every verifying client
  noticing.

Not protected, and worth being clear about:

- **The frontend.** The app that verifies the attestation is served by Vercel. Whoever controls
  that delivery controls whether the check happens at all. Attestation of the server does not
  fix a compromised page, and nothing here claims it does.
- **Anything already public on chain.** Gas credits are ordinary `x/feegrant` state; the vault's
  grantee list is world-readable whatever this server runs inside.
- **Trust itself.** It moves rather than disappears: from the operator to Intel's attestation
  chain, the KMS policy, and the correctness of dstack.

## Before deploying

The image has to be pullable by the CVM, and pinned by digest. A tag is a pointer somebody can
move, and an attestation covering "whatever `:latest` was that morning" proves nothing.

```bash
gh api orgs/Nieuport-Labs/packages/container/private-gas-server/versions --jq '.[0] | {tags: .metadata.container.tags, digest: .name}'
```

Put that digest in `docker-compose.phala.yml`, commit it, and treat changing it as a release:
the app id changes with it, and every client pinning the old one will — correctly — refuse.

## Deploying

The Phala Cloud account and the bill are yours. Nothing below should be run by anybody else.

```bash
npm install -g phala
phala auth login
```

The admin password is the one secret that has to go in at deploy time, and it goes in encrypted:
the CLI encrypts environment variables client-side with X25519 against the CVM's key, so the
host never sees them.

```bash
phala deploy -c docker-compose.phala.yml -n sscrt-gas-provider -e ADMIN_PASSWORD=...
```

Generate that password in your password manager. It encrypts the provider's mnemonic, and there
is no recovery path if it is lost.

```bash
phala cvms get sscrt-gas-provider --json | jq -r '.public_urls[0].app'
```

## The wallet

**Generate it inside the CVM, from the dashboard, after verifying the attestation.** The
mnemonic is then created in memory the host cannot read, shown to you once, and stored encrypted
on the sealed disk. It never exists anywhere else.

Importing an existing mnemonic through encrypted environment variables also works and is
defensible — it is encrypted client-side and only decrypted inside the enclave — but it puts the
seed into a deployment record, and generating it inside avoids that entirely.

Either way the wallet needs native SCRT: every credit sold is paid into the vault out of it, and
a cold buyer's first transaction is covered by a small allowance from it. Funding it is an
ordinary transfer you make yourself.

## Verifying, which is the whole point

The server exposes an unauthenticated endpoint for exactly this:

```bash
curl "https://<your-cvm>/attestation?nonce=$(openssl rand -hex 16)"
```

The nonce is required and it is not ceremony. Without one, a quote proves that this image ran
somewhere at some point — not that the thing answering you right now is that image. A captured
quote replays perfectly.

What the answer contains and what to do with it:

| Field | Check |
| --- | --- |
| `quote` | Verify the TDX signature chains to Intel. `https://cloud-api.phala.com/api/v1/attestations/verify` does it, or do it yourself if you would rather not ask Phala about Phala. |
| `nonce` | Must be the one you just sent. If it is not, you are looking at a replay. |
| `info.composeHash` | Must equal the hash of the `docker-compose.phala.yml` you have read. This is the step that ties the signature to *this* code rather than to some code. |
| `info.appId` | Pin it. It changes when the compose file changes, which is what you want to be told about. |
| `eventLog` | For replaying the RTMR measurements rather than trusting the summary. Optional, and the difference between checking and thoroughly checking. |

Outside a CVM the endpoint answers `501 no_attestation` and says plainly that anything this
server claims about deleting your permit is a promise. That is the honest answer, and it is why
the endpoint is not allowed to be silent about it.
