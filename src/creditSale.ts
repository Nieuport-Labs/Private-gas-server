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
import { config } from "./config.js";
import { getPaymentGasConstant } from "./payment.js";
import { GAS_BUY } from "./gasVault.js";

/** The same buffer quote.ts applies, kept here so the floor is priced against the real fee. */
const GAS_BUFFER = 1.2;

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
 * What one sale costs the provider: the buyer's transaction, which its allowance pays for, plus
 * the delivery transaction it signs afterwards.
 */
export function providerCostUscrt(): bigint {
  const gasLimit = Math.ceil(getPaymentGasConstant() * GAS_BUFFER);
  const paymentFee = Math.ceil(gasLimit * config.nativeGasPriceUscrt);
  const deliveryFee = Math.ceil(GAS_BUY * config.nativeGasPriceUscrt);
  return BigInt(paymentFee + deliveryFee);
}

/**
 * The smallest sale that does not lose the provider money.
 *
 * Derived rather than configured, so it tracks the markup and the gas price instead of drifting
 * away from them. It matters more than it looks: it is the amount of sSCRT somebody has to hold
 * before they can transact at all, and anyone below it has to go and get more — from an
 * exchange, or from whoever paid them. Either is a public event linking two parties who had
 * been kept apart. A floor of a few tenths of a SCRT keeps that door shut for all but dust.
 */
export function minimumCredits(): bigint {
  const { feeMarkupPercent } = getSettings();
  if (feeMarkupPercent <= 0) {
    throw new CreditSaleError("a markup of zero cannot cover the cost of a sale");
  }
  const basisPoints = BigInt(Math.round(feeMarkupPercent * 100));
  // margin = credits * bp / 10000, and it has to reach the cost. Rounded up.
  return (providerCostUscrt() * 10_000n + basisPoints - 1n) / basisPoints;
}

/**
 * The largest purchase this balance can afford, capped at the configured size.
 *
 * Sizing the sale to the buyer rather than refusing anyone who cannot afford the full amount is
 * the difference between "you can transact if you hold ten SCRT" and "you can transact". The
 * second is the point of the whole design.
 */
export function affordablePurchase(balanceUscrt: string): CreditQuote {
  const balance = BigInt(balanceUscrt);
  const ceiling = BigInt(getSettings().creditPurchaseUscrt);
  const minimum = minimumCredits();

  // Invert the markup: the most credit whose price this balance covers.
  const basisPoints = BigInt(Math.round(getSettings().feeMarkupPercent * 100));
  const affordable = (balance * 10_000n) / (10_000n + basisPoints);
  const credits = affordable < ceiling ? affordable : ceiling;

  if (credits < minimum) {
    throw new CreditSaleError(
      `an sSCRT balance of ${balance} is too small to buy gas credits: the smallest sale that ` +
        `covers what it costs the provider is ${minimum} uscrt of credits, at ` +
        `${priceCredits(minimum.toString()).priceSscrt} sSCRT`,
    );
  }
  return priceCredits(credits.toString());
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

  // A floor as well as a ceiling. Without it a client could ask for one uscrt of credit and have
  // the provider pay a delivery transaction for it.
  const minimum = minimumCredits();
  if (BigInt(requestedUscrt) < minimum) {
    throw new CreditSaleError(
      `at least ${minimum} uscrt of credits has to be bought for the sale to cover its own ` +
        `cost; asked for ${requestedUscrt}`,
    );
  }

  return priceCredits(requestedUscrt);
}
