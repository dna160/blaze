import { describe, expect, it } from "vitest";

import { BookingModelNotImplementedError } from "../src/booking-model/not-implemented.js";
import { getBookingModelStrategy } from "../src/booking-model/registry.js";

describe("getBookingModelStrategy", () => {
  it("resolves RECURRING_LEASE to a fully working strategy", () => {
    const strategy = getBookingModelStrategy("RECURRING_LEASE");
    expect(strategy.kind).toBe("RECURRING_LEASE");
    expect(strategy.lifecycleVerbs).toContain("move_in");
  });

  it("resolves NIGHTLY to a working strategy whose computeFinalSettlement is still a typed stub", () => {
    const strategy = getBookingModelStrategy("NIGHTLY");
    expect(strategy.kind).toBe("NIGHTLY");
    expect(strategy.lifecycleVerbs.length).toBeGreaterThan(0);
    expect(() => strategy.computeFinalSettlement({} as never, {} as never, {} as never, new Date())).toThrow(
      BookingModelNotImplementedError,
    );
  });

  it.each(["DURATION_ORDER", "HOURLY_SLOT"] as const)(
    "resolves %s to a typed stub that satisfies the interface but is not implemented",
    (kind) => {
      const strategy = getBookingModelStrategy(kind);
      expect(strategy.kind).toBe(kind);
      expect(strategy.lifecycleVerbs.length).toBeGreaterThan(0);
      expect(() => strategy.computeInitialInvoice({} as never, {} as never, {} as never)).toThrow(
        BookingModelNotImplementedError,
      );
    },
  );
});
