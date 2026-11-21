import { describe, expect, it } from "vitest";

import { DEPOSIT_REFUND_DAYS, depositLeaseEnd, depositRefundDueAt, depositRemaining } from "../src/deposits.js";

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("depositLeaseEnd / depositRefundDueAt (PRD go-live 2 §3.1, T&C IV.3)", () => {
  it("has no end, and so no refund date, for an open-ended lease without notice", () => {
    expect(depositLeaseEnd({ endDate: null, noticeEffectiveDate: null })).toBeNull();
    expect(depositRefundDueAt({ endDate: null, noticeEffectiveDate: null })).toBeNull();
  });

  it("is due 30 days after the term end", () => {
    expect(DEPOSIT_REFUND_DAYS).toBe(30);
    expect(depositRefundDueAt({ endDate: d("2027-02-21"), noticeEffectiveDate: null })?.toISOString().slice(0, 10)).toBe("2027-03-23");
  });

  it("follows the notice date when notice ends the lease before its term, or the lease has no term", () => {
    expect(depositLeaseEnd({ endDate: d("2027-02-21"), noticeEffectiveDate: d("2027-01-15") })).toEqual(d("2027-01-15"));
    expect(depositRefundDueAt({ endDate: d("2027-02-21"), noticeEffectiveDate: d("2027-01-15") })?.toISOString().slice(0, 10)).toBe("2027-02-14");
    expect(depositRefundDueAt({ endDate: null, noticeEffectiveDate: d("2026-12-31") })?.toISOString().slice(0, 10)).toBe("2027-01-30");
  });

  it("keeps the term end when the notice date is not earlier", () => {
    expect(depositLeaseEnd({ endDate: d("2027-02-21"), noticeEffectiveDate: d("2027-03-01") })).toEqual(d("2027-02-21"));
  });
});

describe("depositRemaining", () => {
  it("is amount minus applied while the deposit is open", () => {
    expect(depositRemaining({ amount: "2100000.00", appliedAmount: "300000.00", status: "PARTIALLY_APPLIED" })).toBe(1_800_000);
    expect(depositRemaining({ amount: "2100000.00", appliedAmount: "0", status: "REFUND_REQUESTED" })).toBe(2_100_000);
    expect(depositRemaining({ amount: "1100000.00", appliedAmount: "1100000.00", status: "APPLIED" })).toBe(0);
  });

  it("is nothing once refunded, whatever was applied", () => {
    expect(depositRemaining({ amount: "2100000.00", appliedAmount: "300000.00", status: "REFUNDED" })).toBe(0);
  });
});
