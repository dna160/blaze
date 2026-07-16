import { StateMachine, type Transition } from "./fsm.js";

export type InvoiceStatus =
  | "SCHEDULED"
  | "ISSUED"
  | "OVERDUE"
  | "PAID"
  | "PARTIALLY_REFUNDED"
  | "REFUNDED"
  | "VOID"
  | "CREDITED";

export type InvoiceEvent =
  | "ISSUE"
  | "DUE_DATE_PASSED"
  | "PAYMENT_RECEIVED"
  | "CANCEL"
  | "ADJUST"
  | "REFUND_PARTIAL"
  | "REFUND_FULL";

/**
 * "Invoices are immutable once ISSUED; corrections happen via credit note,
 * never edit-in-place" (PRD §8.2) — ADJUST does not mutate line items, it
 * marks this invoice CREDITED and the caller is responsible for creating a
 * CreditNote + a fresh replacement Invoice (supersededByInvoiceId).
 */
const TRANSITIONS: ReadonlyArray<Transition<InvoiceStatus, InvoiceEvent, void>> = [
  { from: "SCHEDULED", event: "ISSUE", to: "ISSUED" },
  { from: "SCHEDULED", event: "CANCEL", to: "VOID" },
  { from: "ISSUED", event: "DUE_DATE_PASSED", to: "OVERDUE" },
  { from: "ISSUED", event: "PAYMENT_RECEIVED", to: "PAID" },
  { from: "ISSUED", event: "CANCEL", to: "VOID" },
  { from: "ISSUED", event: "ADJUST", to: "CREDITED" },
  { from: "OVERDUE", event: "PAYMENT_RECEIVED", to: "PAID" },
  { from: "OVERDUE", event: "ADJUST", to: "CREDITED" },
  { from: "PAID", event: "REFUND_PARTIAL", to: "PARTIALLY_REFUNDED" },
  { from: "PAID", event: "REFUND_FULL", to: "REFUNDED" },
];

export const invoiceFsm = new StateMachine<InvoiceStatus, InvoiceEvent, void>(TRANSITIONS);
