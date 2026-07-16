import {
  durationOrderBookingFsm,
  nightlyBookingFsm,
  recurringLeaseBookingFsm,
  type BookingEvent,
  type BookingStatus,
  type BookingActivationContext,
  GuardFailedError,
  IllegalTransitionError,
} from "@rentos/domain";

export { GuardFailedError, IllegalTransitionError };
export type { BookingStatus, BookingEvent, BookingActivationContext };

/** Dispatches to the right booking FSM for the AssetType's booking model — the one place that switches on it (PRD §5.2 rule). */
export function bookingFsmFor(bookingModel: string) {
  switch (bookingModel) {
    case "RECURRING_LEASE":
      return recurringLeaseBookingFsm;
    case "NIGHTLY":
      return nightlyBookingFsm;
    case "DURATION_ORDER":
      return durationOrderBookingFsm;
    default:
      throw new Error(`No booking FSM wired for booking model "${bookingModel}" yet (Phase 3 scope).`);
  }
}
