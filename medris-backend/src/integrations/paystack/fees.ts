import { koboToNaira } from "./money.js";

/**
 * Paystack's fee on a local (Nigerian) card or bank payment, and the total a buyer is charged so that Levromart
 * receives the order amount in full (the buyer pays Paystack's fee: founder's decision on issue #89).
 *
 * ASSUMED from Paystack's published local pricing and NOT confirmed against paystack.com/pricing from this build
 * environment: 1.5% + ₦100, the ₦100 waived below ₦2,500, and the fee capped at ₦2,000. Check them against the
 * pricing page and the Paystack dashboard before go-live (issue #103); change them here only.
 */
export const PAYSTACK_LOCAL_FEES = {
  percent: 0.015,
  flatKobo: 10_000,
  flatWaivedBelowKobo: 250_000,
  capKobo: 200_000,
} as const;

/** The fee Paystack takes from a payment of `grossKobo` (rounded up to the next kobo). */
export function paystackFeeOn(grossKobo: number, fees = PAYSTACK_LOCAL_FEES): number {
  const flat = grossKobo >= fees.flatWaivedBelowKobo ? fees.flatKobo : 0;
  return Math.min(fees.capKobo, Math.ceil(grossKobo * fees.percent) + flat);
}

/** The smallest total whose payment leaves `netKobo` after Paystack's fee: { grossKobo, feeKobo }. */
export function grossUpForBuyerFees(netKobo: number, fees = PAYSTACK_LOCAL_FEES): { grossKobo: number; feeKobo: number } {
  if (!Number.isInteger(netKobo) || netKobo <= 0) throw new RangeError("The amount must be a positive whole number of kobo.");
  let gross = Math.ceil(netKobo / (1 - fees.percent));
  if (gross >= fees.flatWaivedBelowKobo) gross = Math.ceil((netKobo + fees.flatKobo) / (1 - fees.percent));
  if (gross - netKobo > fees.capKobo) gross = netKobo + fees.capKobo;
  // rounding can leave us a kobo short; move up until the order amount is covered, and step back while it is more than covered
  while (gross - paystackFeeOn(gross, fees) < netKobo) gross++;
  while (gross > netKobo && gross - 1 - paystackFeeOn(gross - 1, fees) >= netKobo) gross--;
  return { grossKobo: gross, feeKobo: gross - netKobo };
}

export { koboToNaira };
