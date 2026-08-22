import { addMonthsClamped } from "../pricing/term-schedule.js";

/**
 * Blackout rule (PRD v2 D2): a unit stays unavailable to OTHER customers
 * for `blackoutMonths` after a booking's end date — the deposit-covered
 * month — so a lease 1 Aug → 1 Sep holds the unit until 1 Oct.
 *
 * Both sides get a hold window [start, end + blackout); two bookings
 * conflict when their hold windows overlap. Checking both sides (not just
 * the existing booking's) is what stops a new lease from being wedged in
 * such that ITS deposit month would run into the existing lease's start.
 *
 * Pure date math — the database layer (`findAvailableStorageAsset`) feeds
 * it the committed bookings on a candidate unit.
 */

export interface HoldWindowInput {
  startDate: Date;
  /** Exclusive end. Null/undefined = indefinite (a legacy month-to-month lease) — never frees. */
  endDate?: Date | null;
}

export function holdWindowEnd(booking: HoldWindowInput, blackoutMonths: number): Date | null {
  if (!booking.endDate) return null;
  return blackoutMonths > 0 ? addMonthsClamped(booking.endDate, blackoutMonths) : booking.endDate;
}

/** True when `candidate` cannot share the unit with `existing`. */
export function holdWindowsOverlap(candidate: HoldWindowInput, existing: HoldWindowInput, blackoutMonths: number): boolean {
  const candidateEnd = holdWindowEnd(candidate, blackoutMonths);
  const existingEnd = holdWindowEnd(existing, blackoutMonths);
  const existingStartsBeforeCandidateEnds = candidateEnd === null || existing.startDate.getTime() < candidateEnd.getTime();
  const existingEndsAfterCandidateStarts = existingEnd === null || existingEnd.getTime() > candidate.startDate.getTime();
  return existingStartsBeforeCandidateEnds && existingEndsAfterCandidateStarts;
}

export interface CommittedBookingLike extends HoldWindowInput {
  id: string;
  customerId: string;
}

export interface AvailabilityCheckOptions {
  blackoutMonths: number;
  /** The customer asking — their own bookings on this unit that the new one extends don't block it. */
  customerId?: string;
  /** Set when the new booking is an extension of a specific existing booking (same unit, same customer). */
  extendsBookingId?: string;
}

/**
 * Is a unit with these committed bookings free for `candidate`? An
 * extension (same customer, `extendsBookingId` pointing at the booking it
 * continues) is exempt from that booking's blackout month — the occupant
 * can always roll into their own deposit month (PRD v2 D2).
 */
export function isUnitFreeFor(
  candidate: HoldWindowInput,
  committed: readonly CommittedBookingLike[],
  options: AvailabilityCheckOptions,
): boolean {
  for (const existing of committed) {
    const isOwnExtension =
      options.extendsBookingId !== undefined &&
      existing.id === options.extendsBookingId &&
      options.customerId !== undefined &&
      existing.customerId === options.customerId;
    if (isOwnExtension) {
      // The extension must still start no earlier than the parent ends — a
      // customer can't "extend" into a period they're already paying for.
      if (existing.endDate && candidate.startDate.getTime() < existing.endDate.getTime()) return false;
      continue;
    }
    if (holdWindowsOverlap(candidate, existing, options.blackoutMonths)) return false;
  }
  return true;
}
