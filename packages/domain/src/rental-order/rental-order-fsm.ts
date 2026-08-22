// BUILD-SPEC C4 — the discrete monthly rental lifecycle as a typed FSM.
//
// Every month is its own closed-ended RentalOrder. Renewal does NOT extend an
// order — it produces a NEW order (see renewal.service), gated on the customer's
// H-14 confirmation. This machine only governs a single order's own transitions;
// the service layer owns creating the successor order on RENEWAL_CONFIRMED and
// releasing the unit to the waitlist on RENEWAL_DECLINED.

import { StateMachine, type Transition } from "../state-machine/fsm.js";

export type RentalOrderStatus =
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "AWAITING_PAYMENT"
  | "ACTIVE"
  | "RENEWAL_OFFERED"
  | "RENEWAL_CONFIRMED"
  | "RENEWAL_DECLINED"
  | "EXPIRING"
  | "COMPLETED"
  | "DEFAULTED"
  | "CANCELLED";

export type RentalOrderEvent =
  | "APPROVE" // staff approves + assigns a unit (#11)
  | "ISSUE" // contract generated, invoice issued -> awaiting payment
  | "ACTIVATE" // invoice paid AND contract signed
  | "OFFER_RENEWAL" // H-14 prompt sent
  | "CONFIRM_RENEWAL" // customer said yes -> service spawns successor order
  | "DECLINE_RENEWAL" // customer said no, OR H-7 no-reply (B1) -> release to waitlist
  | "ENTER_EXPIRING" // near period end, not renewing
  | "COMPLETE" // period ended
  | "DEFAULT" // unpaid past due
  | "CANCEL"; // staff cancellation / rejection before activation

/** Guard context for ACTIVATE — both gates must be closed (order-based mirror of Booking). */
export interface RentalOrderActivationContext {
  invoicePaid: boolean;
  contractSigned: boolean;
}

export const RENTAL_ORDER_TRANSITIONS: ReadonlyArray<
  Transition<RentalOrderStatus, RentalOrderEvent, RentalOrderActivationContext>
> = [
  { from: "PENDING_APPROVAL", event: "APPROVE", to: "APPROVED" },
  { from: "PENDING_APPROVAL", event: "CANCEL", to: "CANCELLED" },

  { from: "APPROVED", event: "ISSUE", to: "AWAITING_PAYMENT" },
  { from: "APPROVED", event: "CANCEL", to: "CANCELLED" },

  {
    from: "AWAITING_PAYMENT",
    event: "ACTIVATE",
    to: "ACTIVE",
    guard: (ctx) => ctx.invoicePaid && ctx.contractSigned,
    guardFailureMessage: "activation requires the invoice paid AND the contract signed",
  },
  { from: "AWAITING_PAYMENT", event: "DEFAULT", to: "DEFAULTED" },
  { from: "AWAITING_PAYMENT", event: "CANCEL", to: "CANCELLED" },

  // Renewal — the H-14 offer/confirm/decline gate (C4).
  { from: "ACTIVE", event: "OFFER_RENEWAL", to: "RENEWAL_OFFERED" },
  { from: "ACTIVE", event: "ENTER_EXPIRING", to: "EXPIRING" },
  { from: "RENEWAL_OFFERED", event: "CONFIRM_RENEWAL", to: "RENEWAL_CONFIRMED" },
  // B1 — no customer reply by H-7 is treated as a decline (release to waitlist).
  { from: "RENEWAL_OFFERED", event: "DECLINE_RENEWAL", to: "RENEWAL_DECLINED" },

  // Terminal completion — the period ended; a confirmed renewal has a successor
  // order already spawned, a declined one has released its unit to the waitlist.
  { from: ["ACTIVE", "EXPIRING", "RENEWAL_CONFIRMED", "RENEWAL_DECLINED"], event: "COMPLETE", to: "COMPLETED" },
];

export const rentalOrderFsm = new StateMachine<
  RentalOrderStatus,
  RentalOrderEvent,
  RentalOrderActivationContext
>(RENTAL_ORDER_TRANSITIONS);
