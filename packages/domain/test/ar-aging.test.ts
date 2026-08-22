import { describe, expect, it } from "vitest";

import { bucketReceivables } from "../src/finance/ar-aging.js";

const asOf = new Date(2026, 7, 1); // 1 Aug — the owner's example
const days = (n: number) => new Date(asOf.getTime() + n * 24 * 60 * 60 * 1000);

describe("bucketReceivables", () => {
  const invoices = [
    { totalAmount: "100", dueDate: days(0), status: "ISSUED" }, // due today -> overdue.current
    { totalAmount: "200", dueDate: days(-10), status: "OVERDUE" }, // 10 days past
    { totalAmount: "300", dueDate: days(-45), status: "OVERDUE" }, // 45 days past
    { totalAmount: "400", dueDate: days(-90), status: "OVERDUE" }, // 90 days past
    { totalAmount: "500", dueDate: days(15), status: "ISSUED" }, // coming in 15 days
    { totalAmount: "600", dueDate: days(45), status: "SCHEDULED" }, // coming in 45 days
    { totalAmount: "700", dueDate: days(75), status: "SCHEDULED" }, // coming in 75 days
    { totalAmount: "800", dueDate: days(120), status: "SCHEDULED" }, // beyond a 90-day horizon
  ];

  it("splits overdue by days past due and coming-due by days until due, within the horizon", () => {
    const r = bucketReceivables(invoices, asOf, 90);
    expect(r.overdue).toEqual({ current: "100", d1_30: "200", d31_60: "300", d60_plus: "400", total: "1000" });
    expect(r.comingDue).toEqual({ d0_30: "500", d31_60: "600", d61_90: "700", total: "1800", beyondHorizon: "800" });
    expect(r.totalOutstanding).toBe("3600");
    expect(r.invoiceCount).toBe(8);
  });

  it("a 30-day horizon moves later cycles into beyondHorizon", () => {
    const r = bucketReceivables(invoices, asOf, 30);
    expect(r.comingDue.d0_30).toBe("500");
    expect(r.comingDue.d31_60).toBe("0");
    expect(r.comingDue.total).toBe("500");
    expect(r.comingDue.beyondHorizon).toBe("2100");
  });

  it("re-ages the same invoices when asOf moves forward", () => {
    const later = bucketReceivables(invoices, days(20), 60);
    // The due-today invoice is now 20 days past, the 10-day one 30 days past, the 15-day one 5 days past.
    expect(later.overdue.d1_30).toBe("800"); // 100 + 200 + 500
    expect(later.overdue.d60_plus).toBe("700"); // 300 (now 65d past) + 400 (now 110d past)
    expect(later.comingDue.d0_30).toBe("600"); // the 45-day cycle is now 25 days out
  });

  it("handles an empty book", () => {
    const r = bucketReceivables([], asOf, 60);
    expect(r.totalOutstanding).toBe("0");
    expect(r.invoiceCount).toBe(0);
  });
});
