// What a gas credit costs, and why the number is not the same on both sides of the counter.
//
// The vault grants exactly what it is paid, 1:1, so it has no room for a margin. The provider's
// margin therefore lives here: the buyer is charged in sSCRT, the vault is paid the smaller
// amount in SCRT, and the difference is what pays for the provider's own gas and its trouble.
//
// sSCRT is pegged 1:1 to SCRT, so no oracle is involved — the two figures are in the same unit
// and differ only by the markup. A token that was not pegged would need a price lookup here, and
// nowhere else.
import { getSettings } from "./settings.js";

export class CreditSaleError extends Error {}

export interface CreditQuote {
  /** Gas credits the buyer receives, in uscrt of allowance. */
  creditsUscrt: string;
  /** What they pay for them, in base units of sSCRT. */
  priceSscrt: string;
  markupPercent: number;
}

/**
 * Price a purchase.
 *
 * Rounds the price up. A rounding error in the buyer's favour is the provider paying for gas it
 * did not sell, repeated once per purchase.
 */
export function priceCredits(creditsUscrt: string): CreditQuote {
  if (!/^\d+$/.test(creditsUscrt) || creditsUscrt === "0") {
    throw new CreditSaleError(`not a positive amount of credits: ${creditsUscrt}`);
  }

  const { feeMarkupPercent } = getSettings();
  const credits = BigInt(creditsUscrt);

  // Integer arithmetic on purpose. Percentages are the one place a float creeps into a balance,
  // and a balance handled as a float is a bug waiting for a large enough number.
  const basisPoints = BigInt(Math.round(feeMarkupPercent * 100));
  const price = (credits * (10_000n + basisPoints) + 9_999n) / 10_000n;

  return {
    creditsUscrt: credits.toString(),
    priceSscrt: price.toString(),
    markupPercent: feeMarkupPercent,
  };
}

/**
 * The default purchase, used when a client asks to buy without naming an amount.
 *
 * Deliberately one figure rather than a range the caller picks freely: the provider has to hold
 * native SCRT to cover whatever it sells, and an unbounded request is a way to drain that
 * reserve in a single call.
 */
export function defaultPurchase(): CreditQuote {
  return priceCredits(getSettings().creditPurchaseUscrt);
}

/**
 * Validate a client-requested amount against what the operator is willing to sell in one go.
 *
 * The ceiling is the configured purchase size; asking for more is refused rather than clamped,
 * because a client that asked for 100 SCRT of credits and silently got 10 would go on believing
 * it has 100.
 */
export function priceRequestedCredits(requestedUscrt: string | undefined): CreditQuote {
  if (requestedUscrt === undefined) return defaultPurchase();

  if (!/^\d+$/.test(requestedUscrt) || requestedUscrt === "0") {
    throw new CreditSaleError(`not a positive amount of credits: ${requestedUscrt}`);
  }

  const ceiling = BigInt(getSettings().creditPurchaseUscrt);
  if (BigInt(requestedUscrt) > ceiling) {
    throw new CreditSaleError(
      `at most ${ceiling} uscrt of credits can be bought in one purchase; asked for ${requestedUscrt}`,
    );
  }

  return priceCredits(requestedUscrt);
}
