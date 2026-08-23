import { describe, expect, it } from "vitest";

import { holdWindowEnd, holdWindowsOverlap, isUnitFreeFor } from "../src/availability/blackout.js";

const aug1 = new Date(2026, 7, 1);
const sep1 = new Date(2026, 8, 1);
const sep15 = new Date(2026, 8, 15);
const oct1 = new Date(2026, 9, 1);
const nov1 = new Date(2026, 10, 1);
const jun1 = new Date(2026, 5, 1);
const jul1 = new Date(2026, 6, 1);
const jun15 = new Date(2026, 5, 15);
const jul15 = new Date(2026, 6, 15);

/** The owner's worked example: booked 1 Aug -> 1 Sep, held until 1 Oct. */
const existing = { id: "A", customerId: "cust-a", startDate: aug1, endDate: sep1 };

describe("holdWindowEnd", () => {
  it("extends the end by the blackout month", () => {
    expect(holdWindowEnd(existing, 1)).toEqual(oct1);
  });
  it("is the plain end date when blackout is disabled", () => {
    expect(holdWindowEnd(existing, 0)).toEqual(sep1);
  });
  it("is open-ended for an indefinite legacy lease", () => {
    expect(holdWindowEnd({ startDate: aug1, endDate: null }, 1)).toBeNull();
  });
});

describe("holdWindowsOverlap (1-month blackout)", () => {
  it("blocks a booking that starts during the blackout month", () => {
    expect(holdWindowsOverlap({ startDate: sep15, endDate: new Date(2026, 9, 15) }, existing, 1)).toBe(true);
  });
  it("allows a booking that starts exactly when the blackout ends", () => {
    expect(holdWindowsOverlap({ startDate: oct1, endDate: nov1 }, existing, 1)).toBe(false);
  });
  it("allows a booking that ends a full month before the existing one starts", () => {
    expect(holdWindowsOverlap({ startDate: jun1, endDate: jul1 }, existing, 1)).toBe(false);
  });
  it("blocks a booking whose own deposit month would run into the existing start", () => {
    expect(holdWindowsOverlap({ startDate: jun15, endDate: jul15 }, existing, 1)).toBe(true);
  });
  it("with blackout disabled, back-to-back bookings are fine", () => {
    expect(holdWindowsOverlap({ startDate: sep1, endDate: oct1 }, existing, 0)).toBe(false);
  });
  it("an indefinite existing lease blocks everything after its start", () => {
    expect(holdWindowsOverlap({ startDate: new Date(2030, 0, 1), endDate: new Date(2030, 1, 1) }, { startDate: aug1, endDate: null }, 1)).toBe(true);
  });
});

describe("isUnitFreeFor", () => {
  it("is free when no committed booking overlaps", () => {
    expect(isUnitFreeFor({ startDate: oct1, endDate: nov1 }, [existing], { blackoutMonths: 1 })).toBe(true);
  });
  it("another customer cannot book into the blackout month", () => {
    expect(isUnitFreeFor({ startDate: sep1, endDate: oct1 }, [existing], { blackoutMonths: 1, customerId: "cust-b" })).toBe(false);
  });
  it("the same customer CAN extend into their own blackout month (D2)", () => {
    expect(
      isUnitFreeFor({ startDate: sep1, endDate: oct1 }, [existing], { blackoutMonths: 1, customerId: "cust-a", extendsBookingId: "A" }),
    ).toBe(true);
  });
  it("an extension cannot start before the parent term ends", () => {
    expect(
      isUnitFreeFor({ startDate: new Date(2026, 7, 20), endDate: oct1 }, [existing], { blackoutMonths: 1, customerId: "cust-a", extendsBookingId: "A" }),
    ).toBe(false);
  });
  it("the exemption only applies to the booking being extended, not every booking by that customer", () => {
    const other = { id: "B", customerId: "cust-a", startDate: new Date(2026, 10, 1), endDate: new Date(2026, 11, 1) };
    expect(
      isUnitFreeFor({ startDate: sep1, endDate: new Date(2026, 11, 1) }, [existing, other], { blackoutMonths: 1, customerId: "cust-a", extendsBookingId: "A" }),
    ).toBe(false);
  });
});
