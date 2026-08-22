import { describe, expect, it } from "vitest";

import { classifyCustomerHealth } from "../src/crm/customer-health.js";

const asOf = new Date(2026, 7, 1);
const days = (n: number) => new Date(asOf.getTime() + n * 24 * 60 * 60 * 1000);

describe("classifyCustomerHealth", () => {
  it("INACTIVE when the customer has no live booking, regardless of invoices", () => {
    expect(classifyCustomerHealth({ hasLiveBooking: false, overdueInvoiceCount: 2, nextDueDate: days(1), asOf })).toBe("INACTIVE");
  });
  it("OVERDUE when anything is past due", () => {
    expect(classifyCustomerHealth({ hasLiveBooking: true, overdueInvoiceCount: 1, nextDueDate: days(20), asOf })).toBe("OVERDUE");
    expect(classifyCustomerHealth({ hasLiveBooking: true, overdueInvoiceCount: 0, nextDueDate: days(-1), asOf })).toBe("OVERDUE");
  });
  it("RISKY inside the 7-day window before the next due date (inclusive)", () => {
    expect(classifyCustomerHealth({ hasLiveBooking: true, overdueInvoiceCount: 0, nextDueDate: days(7), asOf })).toBe("RISKY");
    expect(classifyCustomerHealth({ hasLiveBooking: true, overdueInvoiceCount: 0, nextDueDate: days(0), asOf })).toBe("RISKY");
  });
  it("HEALTHY when the next payment is more than 7 days out, or nothing is outstanding (paid ahead)", () => {
    expect(classifyCustomerHealth({ hasLiveBooking: true, overdueInvoiceCount: 0, nextDueDate: days(8), asOf })).toBe("HEALTHY");
    expect(classifyCustomerHealth({ hasLiveBooking: true, overdueInvoiceCount: 0, nextDueDate: null, asOf })).toBe("HEALTHY");
  });
  it("honors a custom risky window", () => {
    expect(classifyCustomerHealth({ hasLiveBooking: true, overdueInvoiceCount: 0, nextDueDate: days(10), asOf, riskyWindowDays: 14 })).toBe("RISKY");
  });
});
