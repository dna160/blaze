import { describe, expect, it } from "vitest";

import { GuardFailedError, IllegalTransitionError } from "../src/state-machine/fsm.js";
import { recurringLeaseBookingFsm, type BookingActivationContext } from "../src/state-machine/booking-fsm.js";

const fullyReady: BookingActivationContext = {
  contractRequired: true,
  contractSigned: true,
  firstInvoicePaid: true,
  unitAssigned: true,
};

describe("recurringLeaseBookingFsm — APPROVED -> ACTIVE triple-AND guard (PRD §8.1)", () => {
  it("activates when contract signed AND invoice paid AND unit assigned", async () => {
    const result = await recurringLeaseBookingFsm.fire("APPROVED", "ACTIVATE", fullyReady);
    expect(result.to).toBe("ACTIVE");
  });

  it("rejects activation when contract required but not signed", async () => {
    await expect(
      recurringLeaseBookingFsm.fire("APPROVED", "ACTIVATE", { ...fullyReady, contractSigned: false }),
    ).rejects.toThrow(GuardFailedError);
  });

  it("rejects activation when first invoice unpaid", async () => {
    await expect(
      recurringLeaseBookingFsm.fire("APPROVED", "ACTIVATE", { ...fullyReady, firstInvoicePaid: false }),
    ).rejects.toThrow(GuardFailedError);
  });

  it("rejects activation when no unit assigned", async () => {
    await expect(
      recurringLeaseBookingFsm.fire("APPROVED", "ACTIVATE", { ...fullyReady, unitAssigned: false }),
    ).rejects.toThrow(GuardFailedError);
  });

  it("allows activation without a signed contract when the tenant does not require one", async () => {
    const result = await recurringLeaseBookingFsm.fire("APPROVED", "ACTIVATE", {
      ...fullyReady,
      contractRequired: false,
      contractSigned: false,
    });
    expect(result.to).toBe("ACTIVE");
  });
});

describe("recurringLeaseBookingFsm — full lifecycle happy path", () => {
  it("walks DRAFT through to CLOSED", async () => {
    const seq = [
      "SUBMIT",
      "APPROVE",
      "ACTIVATE",
      "CYCLE_INVOICE_ISSUED",
      "CYCLE_PAYMENT_RECEIVED",
      "GIVE_NOTICE",
      "END_DATE_REACHED",
      "SETTLE",
    ] as const;

    let current: Parameters<typeof recurringLeaseBookingFsm.fire>[0] = "DRAFT";
    for (const event of seq) {
      const result = await recurringLeaseBookingFsm.fire(current, event, fullyReady);
      current = result.to;
    }
    expect(current).toBe("CLOSED");
  });

  it("suspends on unpaid cycle and can default", async () => {
    const s1 = await recurringLeaseBookingFsm.fire("RENEWING", "GRACE_PERIOD_ELAPSED_UNPAID", fullyReady);
    expect(s1.to).toBe("SUSPENDED");
    const s2 = await recurringLeaseBookingFsm.fire(s1.to, "DEFAULT_POLICY_TRIGGERED", fullyReady);
    expect(s2.to).toBe("DEFAULT");
  });

  it("rejects a rejected booking from being approved later", async () => {
    await expect(recurringLeaseBookingFsm.fire("REJECTED", "APPROVE", fullyReady)).rejects.toThrow(
      IllegalTransitionError,
    );
  });
});
