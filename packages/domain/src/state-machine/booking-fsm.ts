import { StateMachine, type Transition } from "./fsm.js";

/**
 * Union of every status reachable by any BookingModel (PRD §8.1 + Appendix
 * B). Mirrors the Prisma BookingStatus enum exactly — kept as a plain
 * string union here so @rentos/domain has zero dependency on
 * @rentos/database (pure domain logic, framework-agnostic per PRD §11).
 */
export type BookingStatus =
  | "DRAFT"
  | "WAITLISTED"
  | "PENDING_APPROVAL"
  | "NEEDS_INFO"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED"
  | "ACTIVE"
  | "LAPSED"
  | "RENEWING"
  | "NOTICE_GIVEN"
  | "SUSPENDED"
  | "DEFAULT"
  | "MOVED_OUT"
  | "CLOSED"
  | "PAID"
  | "CHECKED_IN"
  | "CHECKED_OUT"
  | "NO_SHOW"
  | "EXTENDED"
  | "PICKED_UP"
  | "RETURNED"
  | "INSPECTION";

export type BookingEvent =
  | "SUBMIT"
  | "WAITLIST"
  | "OFFER_UNIT"
  | "TERM_ENDED"
  | "APPROVE"
  | "REJECT"
  | "REQUEST_INFO"
  | "CUSTOMER_REPLY"
  | "EXPIRE"
  | "ACTIVATE"
  | "PAYMENT_TIMEOUT"
  | "CYCLE_INVOICE_ISSUED"
  | "CYCLE_PAYMENT_RECEIVED"
  | "GRACE_PERIOD_ELAPSED_UNPAID"
  | "PAYMENT_RECEIVED"
  | "DEFAULT_POLICY_TRIGGERED"
  | "GIVE_NOTICE"
  | "END_DATE_REACHED"
  | "SETTLE";

/**
 * The triple-AND guard the PRD calls out explicitly: "APPROVED -> ACTIVE
 * requires: contract e-signed (if tenant requires) AND first invoice paid
 * AND unit assigned. All three, no exceptions, enforced in code." (§8.1)
 *
 * We re-check all three at transition time rather than trusting the
 * triggering event alone, so a race (e.g. unit reassigned between approval
 * and payment webhook) cannot slip a booking into ACTIVE with a missing
 * precondition.
 */
export interface BookingActivationContext {
  contractRequired: boolean;
  contractSigned: boolean;
  firstInvoicePaid: boolean;
  unitAssigned: boolean;
}

const RECURRING_LEASE_TRANSITIONS: ReadonlyArray<Transition<BookingStatus, BookingEvent, BookingActivationContext>> = [
  { from: "DRAFT", event: "SUBMIT", to: "PENDING_APPROVAL" },
  // PRD v2 §7 — "full is never a dead end": no capacity at submission
  // parks the request on the waitlist (no unit held); staff offer a unit
  // when one frees up, which re-enters the normal approval path.
  { from: "DRAFT", event: "WAITLIST", to: "WAITLISTED" },
  { from: "WAITLISTED", event: "OFFER_UNIT", to: "PENDING_APPROVAL" },
  { from: "WAITLISTED", event: "REJECT", to: "REJECTED" },
  { from: "WAITLISTED", event: "EXPIRE", to: "EXPIRED" },
  { from: "PENDING_APPROVAL", event: "APPROVE", to: "APPROVED" },
  { from: "PENDING_APPROVAL", event: "REJECT", to: "REJECTED" },
  { from: "PENDING_APPROVAL", event: "REQUEST_INFO", to: "NEEDS_INFO" },
  { from: "NEEDS_INFO", event: "CUSTOMER_REPLY", to: "PENDING_APPROVAL" },
  { from: "PENDING_APPROVAL", event: "EXPIRE", to: "EXPIRED" },
  {
    from: "APPROVED",
    event: "ACTIVATE",
    to: "ACTIVE",
    guardFailureMessage:
      "requires contract signed (if required) AND first invoice paid AND unit assigned",
    guard: (ctx) =>
      (!ctx.contractRequired || ctx.contractSigned) && ctx.firstInvoicePaid && ctx.unitAssigned,
  },
  { from: "APPROVED", event: "PAYMENT_TIMEOUT", to: "LAPSED" },
  { from: "ACTIVE", event: "CYCLE_INVOICE_ISSUED", to: "RENEWING" },
  { from: "RENEWING", event: "CYCLE_PAYMENT_RECEIVED", to: "ACTIVE" },
  { from: "RENEWING", event: "GRACE_PERIOD_ELAPSED_UNPAID", to: "SUSPENDED" },
  { from: "SUSPENDED", event: "PAYMENT_RECEIVED", to: "ACTIVE" },
  { from: "SUSPENDED", event: "DEFAULT_POLICY_TRIGGERED", to: "DEFAULT" },
  { from: ["ACTIVE", "RENEWING", "SUSPENDED"], event: "GIVE_NOTICE", to: "NOTICE_GIVEN" },
  { from: "NOTICE_GIVEN", event: "END_DATE_REACHED", to: "MOVED_OUT" },
  // PRD v2 P6 — a fixed term ends on its own end date without a notice
  // step; the worker's term-lifecycle job fires this. A SUSPENDED lease
  // whose term runs out also ends (the unpaid invoice stays OVERDUE).
  { from: ["ACTIVE", "RENEWING", "SUSPENDED"], event: "TERM_ENDED", to: "MOVED_OUT" },
  { from: "MOVED_OUT", event: "SETTLE", to: "CLOSED" },
];

export const recurringLeaseBookingFsm = new StateMachine<
  BookingStatus,
  BookingEvent,
  BookingActivationContext
>(RECURRING_LEASE_TRANSITIONS);

/**
 * NIGHTLY and DURATION_ORDER share DRAFT -> PENDING_APPROVAL -> APPROVED ->
 * PAID, then diverge (Appendix B). Modeled here as one shared machine since
 * neither has the RECURRING_LEASE triple-AND guard — both key off a single
 * upfront payment instead.
 */
const NIGHTLY_TRANSITIONS: ReadonlyArray<Transition<BookingStatus, BookingEvent, BookingActivationContext>> = [
  { from: "DRAFT", event: "SUBMIT", to: "PENDING_APPROVAL" },
  { from: "PENDING_APPROVAL", event: "APPROVE", to: "APPROVED" },
  { from: "PENDING_APPROVAL", event: "REJECT", to: "REJECTED" },
  { from: "PENDING_APPROVAL", event: "REQUEST_INFO", to: "NEEDS_INFO" },
  { from: "NEEDS_INFO", event: "CUSTOMER_REPLY", to: "PENDING_APPROVAL" },
  { from: "APPROVED", event: "PAYMENT_RECEIVED", to: "PAID" },
  { from: "PAID", event: "ACTIVATE", to: "CHECKED_IN" },
  { from: "CHECKED_IN", event: "SETTLE", to: "CHECKED_OUT" },
  { from: "CHECKED_OUT", event: "END_DATE_REACHED", to: "CLOSED" },
];

export const nightlyBookingFsm = new StateMachine<BookingStatus, BookingEvent, BookingActivationContext>(
  NIGHTLY_TRANSITIONS,
);

const DURATION_ORDER_TRANSITIONS: ReadonlyArray<Transition<BookingStatus, BookingEvent, BookingActivationContext>> = [
  { from: "DRAFT", event: "SUBMIT", to: "PENDING_APPROVAL" },
  { from: "PENDING_APPROVAL", event: "APPROVE", to: "APPROVED" },
  { from: "PENDING_APPROVAL", event: "REJECT", to: "REJECTED" },
  { from: "APPROVED", event: "PAYMENT_RECEIVED", to: "PAID" },
  { from: "PAID", event: "ACTIVATE", to: "PICKED_UP" },
  { from: "PICKED_UP", event: "SETTLE", to: "RETURNED" },
  { from: "RETURNED", event: "CYCLE_INVOICE_ISSUED", to: "INSPECTION" },
  { from: "INSPECTION", event: "END_DATE_REACHED", to: "CLOSED" },
];

export const durationOrderBookingFsm = new StateMachine<
  BookingStatus,
  BookingEvent,
  BookingActivationContext
>(DURATION_ORDER_TRANSITIONS);
