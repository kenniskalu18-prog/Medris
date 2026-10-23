import { describe, expect, it } from "vitest";
import { PAYSTACK_LOCAL_FEES, grossUpForBuyerFees, paystackFeeOn } from "../../src/integrations/paystack/index.js";

describe("paystack fees (buyer pays)", () => {
  it("known amounts", () => {
    // ₦1,000: no flat fee below ₦2,500
    expect(grossUpForBuyerFees(100_000)).toEqual({ grossKobo: 101_523, feeKobo: 1_523 });
    // ₦5,000: 1.5% + ₦100
    const five = grossUpForBuyerFees(500_000);
    expect(five.grossKobo - paystackFeeOn(five.grossKobo)).toBe(500_000);
  });
  it("the fee is capped at ₦2,000", () => {
    expect(grossUpForBuyerFees(20_000_000)).toEqual({ grossKobo: 20_200_000, feeKobo: 200_000 });
    expect(grossUpForBuyerFees(500_000_000).feeKobo).toBe(PAYSTACK_LOCAL_FEES.capKobo);
  });
  it("always leaves exactly the order amount, never a kobo short and never a kobo extra", () => {
    const amounts = [1, 99, 100, 5_000, 99_999, 100_000, 248_000, 249_000, 250_000, 251_000, 600_000, 12_345_678, 19_000_000, 20_000_000, 33_333_333];
    for (const net of amounts) {
      const { grossKobo, feeKobo } = grossUpForBuyerFees(net);
      expect(grossKobo - paystackFeeOn(grossKobo), `net ${net}`).toBeGreaterThanOrEqual(net);
      expect(grossKobo - 1 - paystackFeeOn(grossKobo - 1), `net ${net} (one kobo less)`).toBeLessThan(net);
      expect(feeKobo).toBe(grossKobo - net);
    }
  });
  it("rejects a zero, negative or fractional amount", () => {
    for (const bad of [0, -5, 10.5]) expect(() => grossUpForBuyerFees(bad)).toThrow(RangeError);
  });
});
