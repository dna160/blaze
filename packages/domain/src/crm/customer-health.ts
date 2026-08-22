/**
 * Client-list status (PRD v2 §5.2), in the owner's words: "healthy means
 * paid ahead, risky means 7 days before payment is due, overdue means
 * payment is already due, inactive means they are no longer with us."
 *
 * Pure classification over facts the CRM query already has to gather —
 * no I/O, so the rule is unit-testable and can't drift between the list
 * endpoint and the detail endpoint.
 */

export type CustomerHealth = "HEALTHY" | "RISKY" | "OVERDUE" | "INACTIVE";

export interface CustomerHealthInput {
  /** Any booking in a pre-active or active state (PENDING_APPROVAL ... SUSPENDED/NOTICE_GIVEN). */
  hasLiveBooking: boolean;
  /** Invoices that are OVERDUE, or ISSUED with dueDate < asOf. */
  overdueInvoiceCount: number;
  /** Earliest dueDate among unpaid ISSUED/SCHEDULED invoices, if any. */
  nextDueDate?: Date | null;
  asOf: Date;
  /** "Risky" window — default 7 days before due. */
  riskyWindowDays?: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function classifyCustomerHealth(input: CustomerHealthInput): CustomerHealth {
  if (!input.hasLiveBooking) return "INACTIVE";
  if (input.overdueInvoiceCount > 0) return "OVERDUE";
  if (input.nextDueDate) {
    const daysUntilDue = (input.nextDueDate.getTime() - input.asOf.getTime()) / MS_PER_DAY;
    if (daysUntilDue < 0) return "OVERDUE";
    if (daysUntilDue <= (input.riskyWindowDays ?? 7)) return "RISKY";
  }
  return "HEALTHY";
}
