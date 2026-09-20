# Design: non-refundable onboarding fee

Status: **built.** One deviation from the proposal, forced by the chain and documented under
"Flow" below: the bootstrap grant is capped at a configured ceiling rather than sized to the first
quote's exact fee, because issuing the grant is also what creates the grantee's account, and the
simulation the fee comes from cannot run before that account exists.

## The problem it closes

The provider's exposure has two holes left after the submission checks in `txVerify.ts`.

**A transaction that fails still costs the provider its fee.** The fee is deducted in the ante
handler, before any message runs. If a message then fails, every state change reverts — including
the sSCRT payment — but the fee does not come back. Reordering the bundle does not help: a Cosmos
transaction is atomic as a whole, so one failing message discards the cached state of all of them.
The outflow check in `tokenOutflow.ts` removes the common cause (spending more than you hold), but
a deliberately unroutable recipient still gets through, because nothing before execution can see
it — it sits inside the encrypted message body.

**Onboarding is free and unlimited.** Every new address gets its own grant, and issuing it costs
the provider a transaction. Per address the damage is capped by the grant's spend limit; in
aggregate it is not capped at all, because addresses are free.

## The mechanism

Charge a **non-refundable onboarding fee, equal to the grant's spend limit**, collected inside the
user's first sponsored transaction.

The invariant is what makes this work: a grant can never cost the provider more than its spend
limit, so a fee equal to that limit covers the worst case in advance. Whatever the limit is set
to, the exposure is covered — there is no second number to keep in sync.

**So it is one setting, not two.** `grantSpendLimitUscrt` stays the single dial and the fee is
derived from it. Two independent settings could be misconfigured into an uncovered position; a
derived one cannot.

Default: **1 SCRT** (`1000000`), up from the current 0.5.

### Why the fee cannot be collected up front

The user has no native SCRT. To send the fee in sSCRT they need a transaction, and that
transaction needs gas — which is the reason they are here. So the fee has to ride *inside* the
first sponsored transaction, and the grant has to exist before that transaction is broadcast.

That forces a two-stage grant.

### Flow

1. **`POST /onboard`** stores the permit. **No grant, no chain transaction, no cost.**
   It reads the address's sSCRT balance through the permit and refuses if it cannot cover the
   onboarding fee plus a typical transaction fee. This check is free, and it is the main defence
   against mass onboarding: an attacker now has to park a real sSCRT balance in every address
   before the provider spends anything on it.

2. **First `POST /quote`** for an address with no grant:
   - price the transaction as usual;
   - issue `MsgGrantAllowance` with `spend_limit` set to `bootstrapGrantUscrt` (default 0.06
     SCRT, roughly two sponsored transactions). It cannot be this quote's exact fee: issuing the
     grant is what creates the grantee's account, and the simulation that produces the fee cannot
     run against an account that does not exist. This ceiling is therefore the real bound on what
     a never-paying address can take;
   - return a quote whose payment is `gas fee × markup + onboarding fee`, broken out so the client
     can show both lines.

3. **`POST /submit`** broadcasts as it does today. The fee and the action land together or not at
   all.

4. **After a successful first submit**, replace the grant with one at the full spend limit, as a
   single `[MsgRevokeAllowance, MsgGrantAllowance]` transaction — atomic, so the user is never
   left without a grant. Covered many times over by the fee just collected.

### What each party can lose

| | Before | After |
|---|---|---|
| Failed transaction | provider pays the fee, gets nothing | covered by the fee already collected |
| Address burning its whole grant | up to the spend limit | covered by the fee already collected |
| Mass onboarding | one grant transaction per address, unbounded | needs a funded balance per address first |

**Residual, and it is not removable:** an address that passes the balance check, takes the
bootstrap grant and then submits a transaction designed to fail. The fee is not collected, the
provider is out roughly one grant transaction plus one sponsored fee (~0.029 SCRT once the grant's
gas limit is sized properly), and that address is finished — its bootstrap grant covered exactly one transaction.

The first interaction is unavoidably subsidised. That is the product: someone with no SCRT cannot
pay for anything until something is paid on their behalf. Closing even this would take a gate on
onboarding — an invitation, or proof of an existing funded account — which is a product decision,
not a technical one.

## Verified on chain

Both open questions are answered, at no cost — one from data already on chain, the others by
simulating transactions rather than broadcasting them.

**The allowance is debited by exactly the fee.** The demo address's grant went from 500000 to
342824 uscrt over six sponsored transactions: a difference of 157176, which is exactly 6 x 26196.
No rounding, no overhead. So a bootstrap grant whose spend limit equals the quoted fee covers
exactly one transaction, and **no safety margin is needed**.

**A grant cannot be raised in place, but it can be replaced atomically.** A second
`MsgGrantAllowance` for an existing granter/grantee pair is rejected:

```
code=18  failed to execute message; message index: 0: fee allowance already exists: invalid request
```

`[MsgRevokeAllowance, MsgGrantAllowance]` in **one** transaction simulates cleanly at 17356 gas.
So step 4 is a single atomic transaction, not two, and there is no window in which the user holds
no grant. This is better than the proposal assumed.

**Unrelated finding, and it changes the numbers here.** `onboarding.ts` requests a gas limit of
150000 for `MsgGrantAllowance`. The message actually uses **16961**. Cosmos charges the limit, not
the usage, so the provider pays 15000 uscrt for something that costs 2400 at a 40% margin —
**roughly nine times over, on every onboarding**.

That matters to this design specifically, because the cost of issuing a grant is the number the
whole mass-onboarding analysis turns on. Sizing it properly cuts the free-rider case from about
0.041 SCRT to about **0.029 SCRT**, most of which is now the one sponsored transaction rather than
the grant.

It also raises a question this document does not answer: every gas limit in the codebase is
hardcoded well above measured usage (`wrap` and payment calibration both request 200000 against
~94900 used, contract calibration 400000). Each one is a standing overcharge on the provider. Worth
a separate pass.

## Changes by file

**`src/settings.ts`** — `onboardingFeeSscrt` derived from `grantSpendLimitUscrt`, not stored
separately. Default for the limit raised to `1000000`.

**`src/onboarding.ts`** — splits in two. `storePermit()` does what step 1 describes and issues no
grant. `issueBootstrapGrant(address, feeUscrt)` and `raiseGrantToFullLimit(address)` carry steps 2
and 4. The `grants` table gains a `stage` column (`bootstrap` | `full`).

**`src/quote.ts`** — when the address has no grant, issue the bootstrap grant and add the
onboarding fee to `sscrtPaymentAmount`. The response reports the two components separately.
`requiredSscrt` (already stored for the outflow check) includes the fee.

**`src/submit.ts`** — on a successful broadcast of a `bootstrap`-stage grant's first transaction,
raise the grant. This happens after the outcome is recorded, and a failure to raise must not fail
the user's request — the transaction already succeeded.

**`public/index.html`** — the onboarding fee shown beside the grant limit it is derived from, so
the relationship is visible where the number is edited.

**Demo app** — the first quote shows the fee as its own line with the word non-refundable, before
anything is signed. A user finding out afterwards is a support problem, not a UX detail.

## Denomination

Separate from the above, and worth doing in the same pass because it touches the same screens.

**Base units stay on the wire, in the database and in the protocol.** `uscrt` and the sSCRT base
unit are integers; SCRT is a decimal. Money that crosses a boundary as a decimal acquires rounding
bugs, and this codebase already pays real fees for arithmetic mistakes.

**Human units everywhere a person reads or types**: dashboard labels, settings inputs, job logs,
confirmation dialogs, user-facing error messages, and the demo app's run log. `insufficient sSCRT
balance: have 67538455, need 68000000` becomes `have 67.538455 sSCRT, need 68 sSCRT`.

The one risk is the settings inputs, which become decimals that are converted on save. That
conversion must round-trip exactly and reject more than six decimal places, rather than silently
truncating — a wrong grant limit is a wrong exposure.
