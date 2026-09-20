// Deposit accounting, checked against a throwaway database. No chain, no funds, no network — so
// this runs on every change to the money-handling code.
//
// The arithmetic here decides how much of a failed transaction the provider eats and how much the
// user is asked for next time, and it is the kind of thing that stays quietly wrong for weeks. It
// gets the same treatment as the submission checks.
//
// Usage: DB_PATH=<throwaway> tsx src/scripts/smoke-deposits.ts
import { getDeposit, getDepositRow, topUpNeeded, creditDeposit, debitDeposit } from "../deposits.js";

const TARGET = "1000000"; // 1 sSCRT
const FEE = 26196n; // one sponsored transaction's fee at the current price
const ADDRESS = "secret1testaddressfordepositaccounting000000";

let failures = 0;

function check(name: string, got: unknown, want: unknown): void {
  const ok = String(got) === String(want);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}: ${got}${ok ? "" : ` (want ${want})`}`);
}

// A brand-new address owes the whole deposit — the same code path that later tops it back up,
// which is what keeps the first transaction from being a special case.
check("new address holds nothing", getDeposit(ADDRESS), 0n);
check("new address owes the full deposit", topUpNeeded(ADDRESS, TARGET), BigInt(TARGET));

creditDeposit(ADDRESS, BigInt(TARGET));
check("after the first transaction lands", getDeposit(ADDRESS), BigInt(TARGET));
check("a full deposit owes nothing", topUpNeeded(ADDRESS, TARGET), 0n);

// A failed transaction: the chain kept the fee and reverted the payment, so the loss goes here.
debitDeposit(ADDRESS, FEE);
check("a failure is charged to the deposit", getDeposit(ADDRESS), BigInt(TARGET) - FEE);
check("the shortfall is what the next quote collects", topUpNeeded(ADDRESS, TARGET), FEE);

creditDeposit(ADDRESS, FEE);
check("topping up restores it exactly", getDeposit(ADDRESS), BigInt(TARGET));
check("total paid counts both collections", getDepositRow(ADDRESS)?.total_paid_uscrt, BigInt(TARGET) + FEE);

// Ordinary usage must never touch it: users pay per transaction through the payment message, and
// nothing in a successful transaction calls debitDeposit at all. This asserts the counter is
// unchanged by a no-op credit, which is what a zero top-up on an intact deposit produces.
creditDeposit(ADDRESS, 0n);
check("a zero top-up changes nothing", getDeposit(ADDRESS), BigInt(TARGET));

// More failures than the deposit can absorb. It floors rather than going negative: an address can
// fail its very first transaction before paying anything, and a negative counter would report a
// debt that nobody is going to collect.
debitDeposit(ADDRESS, BigInt(TARGET) * 2n);
check("a debit larger than the balance floors at zero", getDeposit(ADDRESS), 0n);
check("an empty deposit owes the whole amount again", topUpNeeded(ADDRESS, TARGET), BigInt(TARGET));

const UNKNOWN = "secret1neverseenthisaddressbefore0000000000";
check("an unknown address floors cleanly too", debitDeposit(UNKNOWN, FEE), 0n);

console.log(failures === 0 ? "\nOK: deposit accounting behaves" : `\n${failures} case(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
