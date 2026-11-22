import { describe, expect, it } from "vitest";

import {
  arrearsStatus,
  calendarDaysBetween,
  dailyPenalty,
  DEFAULT_MONEY_RULES,
  overtimeCharge,
  penaltyBase,
  penaltyDaysToCharge,
  resolveMoneyRules,
} from "../src/finance/money-rules.js";

describe("resolveMoneyRules", () => {
  it("is all OFF with the T&C numbers when the branch says nothing", () => {
    expect(resolveMoneyRules({})).toEqual(DEFAULT_MONEY_RULES);
    expect(resolveMoneyRules(null)).toEqual(DEFAULT_MONEY_RULES);
    const r = resolveMoneyRules({});
    expect([r.lateFee, r.overstay, r.overtime, r.depositRefundTask, r.arrearsBadge].every((x) => x.enabled === false)).toBe(true);
    expect(r.lateFee).toMatchObject({ ratePerDay: 0.01, maxDays: 14 });
    expect(r.overstay).toMatchObject({ ratePerDay: 0.01, maxDays: 30 });
    expect(r.overtime.hourlyRate).toBe(50_000);
    expect(r.depositRefundTask.days).toBe(30);
  });

  it("turns each rule on separately and takes configured amounts", () => {
    const r = resolveMoneyRules({ moneyRules: { lateFee: { enabled: true, ratePerDay: 0.02, maxDays: 10 }, overtime: { enabled: true, hourlyRate: 75000 } } });
    expect(r.lateFee).toEqual({ enabled: true, ratePerDay: 0.02, maxDays: 10 });
    expect(r.overtime).toEqual({ enabled: true, hourlyRate: 75000 });
    expect(r.overstay.enabled).toBe(false);
  });

  it("ignores nonsense and keeps the default", () => {
    const r = resolveMoneyRules({ moneyRules: { lateFee: { enabled: "yes", ratePerDay: 5, maxDays: -1 } } });
    expect(r.lateFee).toEqual({ enabled: false, ratePerDay: 0.01, maxDays: 14 });
  });
});

describe("late fee (T&C V.3) — 1% per day, at most 14 days", () => {
  it("charges each day once, catches up missed days, and stops at the cap", () => {
    expect(penaltyDaysToCharge(0, 0, 14)).toEqual([]);
    expect(penaltyDaysToCharge(1, 0, 14)).toEqual([1]);
    expect(penaltyDaysToCharge(3, 1, 14)).toEqual([2, 3]); // job missed a day
    expect(penaltyDaysToCharge(3, 3, 14)).toEqual([]); // re-run same day
    expect(penaltyDaysToCharge(20, 13, 14)).toEqual([14]);
    expect(penaltyDaysToCharge(40, 14, 14)).toEqual([]);
  });

  it("is 1% of the bill without deposit, tax or earlier penalties", () => {
    const lines = [
      { lineType: "RENT", amount: "2100000" },
      { lineType: "DEPOSIT", amount: "2100000" },
      { lineType: "TAX", amount: "231000" },
      { lineType: "LATE_FEE", amount: "21000" },
    ];
    expect(penaltyBase(lines).toString()).toBe("2100000");
    expect(dailyPenalty(penaltyBase(lines), 0.01).toString()).toBe("21000");
    // 14 days on Rp 2.100.000 = Rp 294.000 total, and no more.
    expect(penaltyDaysToCharge(30, 0, 14).length * 21000).toBe(294000);
  });

  it("rounds to whole rupiah", () => {
    expect(dailyPenalty("1100050", 0.01).toString()).toBe("11001");
  });
});

describe("overtime (T&C II.8) — Rp 50.000 per hour", () => {
  it("charges hours × rate", () => {
    expect(overtimeCharge(2, 50000).toString()).toBe("100000");
    expect(overtimeCharge(1.5, 50000).toString()).toBe("75000");
    expect(() => overtimeCharge(0, 50000)).toThrow(RangeError);
  });
});

describe("arrears badge (T&C V.5, VI.7)", () => {
  it("is denied only past the threshold, counting from the oldest unpaid due date", () => {
    expect(arrearsStatus([], "2026-11-21", 1)).toMatchObject({ denied: false, overdueCount: 0 });
    expect(arrearsStatus(["2026-11-25"], "2026-11-21", 1).denied).toBe(false); // not due yet
    expect(arrearsStatus(["2026-11-20"], "2026-11-21", 1)).toMatchObject({ denied: false, daysOverdue: 1 }); // 1 day, threshold 1
    expect(arrearsStatus(["2026-11-19", "2026-11-01"], "2026-11-21", 1)).toEqual({ denied: true, oldestDueDate: "2026-11-01", daysOverdue: 20, overdueCount: 2 });
    expect(arrearsStatus(["2026-11-19"], "2026-11-21", 0).denied).toBe(true);
  });

  it("counts calendar days", () => {
    expect(calendarDaysBetween("2026-12-31", "2027-01-01")).toBe(1);
    expect(calendarDaysBetween("2026-11-21", "2026-11-21")).toBe(0);
  });
});
