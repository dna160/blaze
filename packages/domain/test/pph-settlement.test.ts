import { describe, expect, it } from "vitest";

import { applySettlement, expectedPphWithholding, SettlementError, settlementLedger } from "../src/finance/pph-settlement.js";

/**
 * Worked examples from part 1 §8.3 (City Storage's own examples are still
 * owed — part 2 §12 Q5; replace these with theirs when they arrive).
 */
describe("part 1 §8.3 worked examples", () => {
  it("PKP branch: DPP 1.000.000 + PPN 110.000 = 1.110.000; PPh Final 4(2) 10% = 100.000; transfer 1.010.000", () => {
    const dpp = 1_000_000;
    const total = dpp + Math.round(dpp * 0.11);
    const pph = expectedPphWithholding(dpp, "PPH_4_2_FINAL");
    expect(total).toBe(1_110_000);
    expect(pph).toEqual({ type: "PPH_4_2_FINAL", rate: 0.1, amount: 100_000 });
    const out = applySettlement({ total, settled: 0 }, total - pph.amount, pph.amount);
    expect(total - pph.amount).toBe(1_010_000);
    expect(out).toEqual({ settles: 1_110_000, settledAfter: 1_110_000, outstandingAfter: 0, paidInFull: true });
    expect(settlementLedger({ amount: 1_010_000, withheld: 100_000, closing: true, depositShare: 0 })).toEqual({ cash: 1_010_000, prepaidPph: 100_000, arCredit: 1_110_000 });
  });

  it("non-PKP branch: total 1.000.000, withheld 100.000, transfer 900.000", () => {
    const pph = expectedPphWithholding(1_000_000, "PPH_4_2_FINAL");
    const out = applySettlement({ total: 1_000_000, settled: 0 }, 900_000, pph.amount);
    expect(out.paidInFull).toBe(true);
  });

  it("PPh 23 is 2% by default; a configured rate wins; nonsense falls back", () => {
    expect(expectedPphWithholding(1_000_000, "PPH_23").amount).toBe(20_000);
    expect(expectedPphWithholding(1_000_000, "PPH_4_2_FINAL", { PPH_4_2_FINAL: 0.05 }).amount).toBe(50_000);
    expect(expectedPphWithholding(1_000_000, "PPH_23", { PPH_23: 7 }).amount).toBe(20_000);
    expect(expectedPphWithholding(1_000_000, null).type).toBe("PPH_4_2_FINAL");
  });
});

describe("short payments, tolerance and overpayment", () => {
  it("a short transfer leaves the balance open", () => {
    const first = applySettlement({ total: 1_110_000, settled: 0 }, 500_000, 100_000);
    expect(first).toMatchObject({ settledAfter: 600_000, outstandingAfter: 510_000, paidInFull: false });
    const second = applySettlement({ total: 1_110_000, settled: first.settledAfter }, 510_000, 0);
    expect(second.paidInFull).toBe(true);
  });

  it("Rp 1 short or over still settles", () => {
    expect(applySettlement({ total: 1_110_000, settled: 0 }, 1_009_999, 100_000).paidInFull).toBe(true);
    expect(applySettlement({ total: 1_110_000, settled: 0 }, 1_010_001, 100_000).paidInFull).toBe(true);
  });

  it("refuses more than the outstanding amount, nothing, and negatives", () => {
    expect(() => applySettlement({ total: 1_110_000, settled: 0 }, 1_200_000, 0)).toThrow(SettlementError);
    expect(() => applySettlement({ total: 1_110_000, settled: 1_000_000 }, 200_000, 0)).toThrow(SettlementError);
    expect(() => applySettlement({ total: 1_110_000, settled: 0 }, 0, 0)).toThrow(SettlementError);
    expect(() => applySettlement({ total: 1_110_000, settled: 0 }, -5, 10)).toThrow(SettlementError);
  });
});

describe("ledger with a deposit on the invoice", () => {
  it("carves the deposit's cash out of the closing payment only, so AR closes at total − deposit", () => {
    // Proforma: rent 2.100.000 + deposit 2.100.000 = 4.200.000; PPh 10% on the rent = 210.000.
    const p1 = settlementLedger({ amount: 1_000_000, withheld: 210_000, closing: false, depositShare: 2_100_000 });
    const p2 = settlementLedger({ amount: 2_990_000, withheld: 0, closing: true, depositShare: 2_100_000 });
    expect(p1).toEqual({ cash: 1_000_000, prepaidPph: 210_000, arCredit: 1_210_000 });
    expect(p2).toEqual({ cash: 890_000, prepaidPph: 0, arCredit: 890_000 });
    expect(p1.arCredit + p2.arCredit).toBe(2_100_000);
    expect(p1.cash + p2.cash + 2_100_000 + p1.prepaidPph).toBe(4_200_000);
  });

  it("refuses a closing transfer smaller than the deposit", () => {
    expect(() => settlementLedger({ amount: 1_000_000, withheld: 0, closing: true, depositShare: 2_100_000 })).toThrow(SettlementError);
  });
});
