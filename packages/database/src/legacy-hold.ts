/**
 * The legacy hold (owner, 2026-11-17: "don't send the overdue invoices … the
 * messaging shouldn't send the past messages, just starting from now").
 *
 * A branch whose book was imported from another system (Booqable) keeps being
 * run in that system until cut-over. While `featureFlags.legacy_automation_hold`
 * is true, RentOS does nothing automatic for the IMPORTED rentals — no
 * recurring invoice, no payment reminder, no overdue reminder, no suspension —
 * so no customer hears from two systems and nothing is billed twice. Rentals
 * and invoices made in RentOS itself are untouched by the hold: they bill and
 * remind as usual. Lifting the hold (Settings → Branch) is the cut-over.
 *
 * An imported rental is a Booking with `legacyBookingNumber` set; an imported
 * invoice is one attached to such a booking.
 */
export function legacyAutomationHold(featureFlags: unknown): boolean {
  return (featureFlags as Record<string, unknown> | null)?.["legacy_automation_hold"] === true;
}
