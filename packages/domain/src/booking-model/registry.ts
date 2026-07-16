import { durationOrderStrategy } from "./duration-order.strategy.js";
import { hourlySlotStrategy } from "./hourly-slot.strategy.js";
import { nightlyStrategy } from "./nightly.strategy.js";
import { recurringLeaseStrategy } from "./recurring-lease.strategy.js";

import type { BookingModelKind, BookingModelStrategy } from "./types.js";

const STRATEGIES: Record<BookingModelKind, BookingModelStrategy> = {
  RECURRING_LEASE: recurringLeaseStrategy,
  NIGHTLY: nightlyStrategy,
  DURATION_ORDER: durationOrderStrategy,
  HOURLY_SLOT: hourlySlotStrategy,
};

/**
 * The single lookup point from AssetType.bookingModel to its strategy.
 * Every booking/finance code path that needs vertical-specific behavior
 * goes through here — never a hand-rolled switch statement scattered
 * across modules (PRD §5.2 rule, enforced in code review).
 */
export function getBookingModelStrategy(kind: BookingModelKind): BookingModelStrategy {
  return STRATEGIES[kind];
}
