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

const ctx = (): BookingActivationContext => fullyReady;

describe("recurringLeaseBookingFsm — PRD v2 waitlist + term end", () => {
  it("DRAFT can be waitlisted, and a waitlisted booking can be offered a unit back into approval", async () => {
    expect((await recurringLeaseBookingFsm.fire("DRAFT", "WAITLIST", ctx())).to).toBe("WAITLISTED");
    expect((await recurringLeaseBookingFsm.fire("WAITLISTED", "OFFER_UNIT", ctx())).to).toBe("PENDING_APPROVAL");
    expect((await recurringLeaseBookingFsm.fire("WAITLISTED", "REJECT", ctx())).to).toBe("REJECTED");
    expect((await recurringLeaseBookingFsm.fire("WAITLISTED", "EXPIRE", ctx())).to).toBe("EXPIRED");
  });

  it("a waitlisted booking cannot be approved directly — it must be offered a unit first", async () => {
    await expect(recurringLeaseBookingFsm.fire("WAITLISTED", "APPROVE", ctx())).rejects.toThrow(IllegalTransitionError);
  });

  it("an active/renewing/suspended term ends straight into MOVED_OUT", async () => {
    expect((await recurringLeaseBookingFsm.fire("ACTIVE", "TERM_ENDED", ctx())).to).toBe("MOVED_OUT");
    expect((await recurringLeaseBookingFsm.fire("RENEWING", "TERM_ENDED", ctx())).to).toBe("MOVED_OUT");
    expect((await recurringLeaseBookingFsm.fire("SUSPENDED", "TERM_ENDED", ctx())).to).toBe("MOVED_OUT");
    await expect(recurringLeaseBookingFsm.fire("APPROVED", "TERM_ENDED", ctx())).rejects.toThrow(IllegalTransitionError);
  });
});
