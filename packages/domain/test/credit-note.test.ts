import { describe, expect, it } from "vitest";

import { money } from "../src/money.js";
import { computeCreditReplacementDraft, type InvoiceSnapshot } from "../src/pricing/credit-note.js";

const original: InvoiceSnapshot = {
  lines: [
    { description: "Admin fee", amount: money("50000"), lineType: "ADMIN_FEE" },
    { description: "Security deposit", amount: money("450000"), lineType: "DEPOSIT" },
    { description: "Rent (15/31 days, prorated)", amount: money("217741.94"), lineType: "RENT" },
    { description: "PPN 11%", amount: money("29451.61"), lineType: "TAX" },
  ],
  totalAmount: money("747193.55"),
  periodStart: new Date("2026-07-01T00:00:00.000Z"),
  periodEnd: new Date("2026-07-31T00:00:00.000Z"),
};

describe("computeCreditReplacementDraft", () => {
  it("scales every line down by the same ratio for a partial credit", () => {
    const draft = computeCreditReplacementDraft(original, money("100000"));

    expect(draft.totalAmount.toString()).toBe("647193.55");
    expect(draft.lines).toHaveLength(4);
    // sum of lines always matches the invoice-level total, cent for cent
    const lineSum = draft.lines.reduce((sum, l) => sum.plus(l.amount), money(0));
    expect(lineSum.toString()).toBe(draft.totalAmount.toString());
    expect(draft.subtotal.plus(draft.taxAmount).toString()).toBe(draft.totalAmount.toString());
  });

  it("preserves lineType on every scaled line (ledger revenue/deposit/tax classification depends on this)", () => {
    const draft = computeCreditReplacementDraft(original, money("100000"));
    expect(draft.lines.map((l) => l.lineType)).toEqual(["ADMIN_FEE", "DEPOSIT", "RENT", "TAX"]);
    // the deposit line shrank proportionally too — it's still flagged DEPOSIT, not silently folded into revenue
    const depositLine = draft.lines.find((l) => l.lineType === "DEPOSIT")!;
    expect(depositLine.amount.lessThan(money("450000"))).toBe(true);
    expect(depositLine.amount.greaterThan(money("0"))).toBe(true);
  });

  it("produces a zero-total draft (no remaining balance) when the credit equals the full invoice", () => {
    const draft = computeCreditReplacementDraft(original, money("747193.55"));
    expect(draft.totalAmount.toString()).toBe("0");
    expect(draft.lines.every((l) => l.amount.toString() === "0")).toBe(true);
  });

  it("sums to the exact remaining balance even for a tiny credit that rounds awkwardly across four lines", () => {
    const draft = computeCreditReplacementDraft(original, money("0.03"));
    expect(draft.totalAmount.toString()).toBe("747193.52");
    const lineSum = draft.lines.reduce((sum, l) => sum.plus(l.amount), money(0));
    expect(lineSum.toString()).toBe("747193.52");
  });

  it("falls back to `now` for period bounds when the original invoice has none", () => {
    const draft = computeCreditReplacementDraft({ ...original, periodStart: null, periodEnd: null }, money("1"));
    expect(draft.periodStart).toBeInstanceOf(Date);
    expect(draft.periodEnd).toBeInstanceOf(Date);
  });
});
