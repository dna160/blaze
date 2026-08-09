import { describe, expect, it } from "vitest";

import { rentalOrderFsm } from "../src/rental-order/rental-order-fsm.js";
import { GuardFailedError, IllegalTransitionError } from "../src/state-machine/fsm.js";
import {
  wholeMonthsBetween,
  assertWholeMonths,
  monthlyPeriodEnd,
  assertBillingUnitAllowed,
  NonIntegerMonthError,
  SubMonthlyDisabledError,
} from "../src/rental-order/monthly-guard.js";

const noGuard = { invoicePaid: true, contractSigned: true };

describe("RentalOrder FSM (C4)", () => {
  it("happy path: PENDING_APPROVAL → APPROVED → AWAITING_PAYMENT → ACTIVE", async () => {
    expect((await rentalOrderFsm.fire("PENDING_APPROVAL", "APPROVE", noGuard)).to).toBe("APPROVED");
    expect((await rentalOrderFsm.fire("APPROVED", "ISSUE", noGuard)).to).toBe("AWAITING_PAYMENT");
    expect((await rentalOrderFsm.fire("AWAITING_PAYMENT", "ACTIVATE", noGuard)).to).toBe("ACTIVE");
  });

  it("ACTIVATE requires BOTH invoice paid AND contract signed", async () => {
    await expect(
      rentalOrderFsm.fire("AWAITING_PAYMENT", "ACTIVATE", { invoicePaid: true, contractSigned: false }),
    ).rejects.toBeInstanceOf(GuardFailedError);
    await expect(
      rentalOrderFsm.fire("AWAITING_PAYMENT", "ACTIVATE", { invoicePaid: false, contractSigned: true }),
    ).rejects.toBeInstanceOf(GuardFailedError);
  });

  it("renewal offer → confirm and offer → decline are both legal from RENEWAL_OFFERED", async () => {
    expect((await rentalOrderFsm.fire("ACTIVE", "OFFER_RENEWAL", noGuard)).to).toBe("RENEWAL_OFFERED");
    expect((await rentalOrderFsm.fire("RENEWAL_OFFERED", "CONFIRM_RENEWAL", noGuard)).to).toBe("RENEWAL_CONFIRMED");
    expect((await rentalOrderFsm.fire("RENEWAL_OFFERED", "DECLINE_RENEWAL", noGuard)).to).toBe("RENEWAL_DECLINED");
  });

  it("both confirmed and declined orders complete at period end", async () => {
    expect((await rentalOrderFsm.fire("RENEWAL_CONFIRMED", "COMPLETE", noGuard)).to).toBe("COMPLETED");
    expect((await rentalOrderFsm.fire("RENEWAL_DECLINED", "COMPLETE", noGuard)).to).toBe("COMPLETED");
  });

  it("unpaid awaiting-payment order can DEFAULT", async () => {
    expect((await rentalOrderFsm.fire("AWAITING_PAYMENT", "DEFAULT", noGuard)).to).toBe("DEFAULTED");
  });

  it("cannot renew a non-active order", async () => {
    await expect(rentalOrderFsm.fire("APPROVED", "OFFER_RENEWAL", noGuard)).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
  });
});

describe("Monthly-only guard (C3)", () => {
  it("counts whole months exactly", () => {
    expect(wholeMonthsBetween(new Date("2026-01-15T00:00:00Z"), new Date("2026-02-15T00:00:00Z"))).toBe(1);
    expect(wholeMonthsBetween(new Date("2026-01-15T00:00:00Z"), new Date("2026-07-15T00:00:00Z"))).toBe(6);
    expect(wholeMonthsBetween(new Date("2026-01-15T00:00:00Z"), new Date("2027-01-15T00:00:00Z"))).toBe(12);
  });

  it("throws on a non-integer month span (the C3 invariant)", () => {
    expect(() => wholeMonthsBetween(new Date("2026-01-15T00:00:00Z"), new Date("2026-02-20T00:00:00Z"))).toThrow(
      NonIntegerMonthError,
    );
    expect(() => assertWholeMonths(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-15T00:00:00Z"))).toThrow(
      NonIntegerMonthError,
    );
  });

  it("handles end-of-month clamping (Jan 31 + 1 month = Feb 28)", () => {
    const end = monthlyPeriodEnd(new Date("2026-01-31T00:00:00Z"), 1);
    expect(end.toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(wholeMonthsBetween(new Date("2026-01-31T00:00:00Z"), end)).toBe(1);
  });

  it("gates DAILY/WEEKLY behind the tenant flag (default off)", () => {
    expect(() => assertBillingUnitAllowed("MONTH", false)).not.toThrow();
    expect(() => assertBillingUnitAllowed("DAY", false)).toThrow(SubMonthlyDisabledError);
    expect(() => assertBillingUnitAllowed("WEEK", undefined)).toThrow(SubMonthlyDisabledError);
    expect(() => assertBillingUnitAllowed("DAY", true)).not.toThrow();
  });
});
