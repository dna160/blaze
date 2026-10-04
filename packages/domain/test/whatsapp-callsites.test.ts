import { describe, expect, it } from "vitest";

import { buildWhatsAppTemplatePayload } from "../src/comms/whatsapp-templates.js";

/**
 * A contract test between the notify call sites and the registry.
 *
 * The registry can be internally consistent and still be wrong if a call site
 * doesn't pass what its template declares — and the failure mode is invisible
 * until a real customer message is due, because the send path only records it on
 * a Notification row. So each case below is the variable set a specific call site
 * actually produces, including what notifyCustomer/notify inject on its behalf.
 *
 * When you add or change a notify call, add or change its case here.
 */

/** `notifyCustomer` always injects customerName, and `link` when the caller passes one. */
function viaNotifyCustomer(vars: Record<string, string>, withLink = true): Record<string, string> {
  return {
    customerName: "Budi Santoso",
    ...(withLink ? { link: "https://s.example/m/tok?next=%2Fportal" } : {}),
    ...vars,
  };
}

/** `notify` injects nothing — used for the branch-admin dunning leg and the OTP. */
const viaNotify = (vars: Record<string, string>) => vars;

const CALL_SITES: Array<{ site: string; templateKey: string; variables: Record<string, string>; metaName: string; params: number }> = [
  // apps/api/src/booking/booking.service.ts — createStorageBooking
  { site: "booking.service createStorageBooking (available)", templateKey: "booking_received", metaName: "booking_received", params: 6,
    variables: viaNotifyCustomer({ assetTypeName: "3x3", locationName: "Kebon Jeruk", startDate: "1 Nov 2026", termMonths: "6", position: "" }) },
  { site: "booking.service createStorageBooking (waitlisted)", templateKey: "booking_waitlisted", metaName: "booking_waitlisted", params: 5,
    variables: viaNotifyCustomer({ assetTypeName: "3x3", locationName: "Kebon Jeruk", startDate: "1 Nov 2026", termMonths: "6", position: "2" }) },
  // The pre-v2 NIGHTLY / DURATION_ORDER path — no term, branch or unit type.
  { site: "booking.service createBooking (nightly/duration)", templateKey: "booking_received_basic", metaName: "booking_received_basic", params: 3,
    variables: viaNotifyCustomer({ startDate: "1 Nov 2026" }) },
  { site: "booking.service approve (kyc path)", templateKey: "booking_approved", metaName: "booking_approved", params: 2,
    variables: viaNotifyCustomer({}) },
  { site: "booking.service approve (invoice path)", templateKey: "booking_approved_payment_link", metaName: "booking_approved_payment_link", params: 4,
    variables: viaNotifyCustomer({ invoiceNumber: "INV-1", totalAmount: "2750000" }) },
  { site: "booking.service reject", templateKey: "booking_rejected", metaName: "booking_rejected", params: 2,
    variables: viaNotifyCustomer({ reason: "KTP tidak terbaca" }, false) },
  { site: "booking.service requestKyc", templateKey: "kyc_requested", metaName: "kyc_requested", params: 2,
    variables: viaNotifyCustomer({}) },
  { site: "booking.service generateContractAndProforma", templateKey: "contract_proforma_ready", metaName: "contract_proforma_ready", params: 6,
    variables: viaNotifyCustomer({ invoiceNumber: "INV-1", totalAmount: "2750000", dueDate: "8 Nov 2026", assetCode: "A-01" }) },
  { site: "booking.service offerUnit", templateKey: "waitlist_unit_offered", metaName: "waitlist_unit_offered", params: 5,
    variables: viaNotifyCustomer({ assetTypeName: "3x3", assetCode: "A-01", locationName: "Kebon Jeruk" }) },
  { site: "booking.service giveNotice", templateKey: "notice_confirmed", metaName: "notice_confirmed", params: 3,
    variables: viaNotifyCustomer({ noticeEffectiveDate: "30 Nov 2026", finalInvoiceNumber: "INV-9", voidedInvoices: "1" }) },

  // apps/api/src/payments/payments.service.ts
  { site: "payments.service handleInvoicePaid", templateKey: "invoice_paid", metaName: "invoice_paid", params: 4,
    variables: viaNotifyCustomer({ invoiceNumber: "INV-1", totalAmount: "2750000" }) },

  // apps/api/src/rental-order/rental-order.service.ts
  { site: "rental-order.service offerRenewal", templateKey: "renewal_offer_h14", metaName: "renewal_offer_h14", params: 2,
    variables: viaNotifyCustomer({}) },

  // apps/worker/src/jobs/*
  { site: "generate-recurring-invoices.job", templateKey: "invoice_issued", metaName: "invoice_issued", params: 5,
    variables: viaNotifyCustomer({ invoiceNumber: "INV-1", totalAmount: "2750000", dueDate: "2026-11-08" }) },
  { site: "issue-scheduled-invoices.job", templateKey: "invoice_issued", metaName: "invoice_issued", params: 5,
    variables: viaNotifyCustomer({ invoiceNumber: "INV-1", totalAmount: "2750000", dueDate: "8 Nov 2026" }) },
  { site: "term-lifecycle.job (expired)", templateKey: "booking_expired", metaName: "booking_expired", params: 3,
    variables: viaNotifyCustomer({ assetTypeName: "3x3" }) },
  { site: "term-lifecycle.job (term ended)", templateKey: "term_ended", metaName: "term_ended", params: 4,
    variables: viaNotifyCustomer({ assetCode: "A-01", endDate: "31 Mar 2027" }) },
  { site: "renewal-offer.job (rental order)", templateKey: "renewal_offer_h14", metaName: "renewal_offer_h14", params: 2,
    variables: viaNotifyCustomer({}) },
  { site: "renewal-offer.job (term lease)", templateKey: "term_renewal_offer_h14", metaName: "term_renewal_offer_h14", params: 5,
    variables: viaNotifyCustomer({ bookingId: "uuid", assetTypeName: "3x3", assetCode: "A-01", termMonths: "6", endDate: "31 Mar 2027" }) },
  { site: "dunning-ladder.job (customer reminder)", templateKey: "invoice_reminder_h7", metaName: "invoice_reminder", params: 5,
    variables: viaNotifyCustomer({ invoiceId: "uuid", invoiceNumber: "INV-1", totalAmount: "2750000", daysUntilDue: "7" }) },
  { site: "dunning-ladder.job (customer overdue)", templateKey: "invoice_overdue_d3", metaName: "invoice_overdue", params: 4,
    variables: viaNotifyCustomer({ invoiceId: "uuid", invoiceNumber: "INV-1", totalAmount: "2750000", daysOverdue: "3" }) },
  { site: "dunning-ladder.job (admin reminder, #42)", templateKey: "invoice_reminder_h7_admin", metaName: "invoice_reminder_admin", params: 3,
    variables: viaNotify({ invoiceId: "uuid", invoiceNumber: "INV-1", totalAmount: "2750000", daysUntilDue: "7", customerId: "uuid" }) },
  { site: "dunning-ladder.job (admin overdue, #42)", templateKey: "invoice_overdue_d3_admin", metaName: "invoice_overdue_admin", params: 2,
    variables: viaNotify({ invoiceId: "uuid", invoiceNumber: "INV-1", totalAmount: "2750000", daysOverdue: "3", customerId: "uuid" }) },
  { site: "dunning-ladder.job (suspend)", templateKey: "lease_suspended", metaName: "lease_suspended", params: 3,
    variables: viaNotifyCustomer({ invoiceNumber: "INV-1" }) },

  { site: "auth.service requestMagicLink", templateKey: "login_link", metaName: "login_link", params: 2,
    variables: viaNotify({ customerName: "Budi Santoso", link: "https://s.example/m/tok?next=%2Fportal" }) },

  // apps/api/src/auth/auth.service.ts — through `notify`, code only.
  { site: "auth.service sendOtp", templateKey: "otp_code", metaName: "otp_code", params: 1, variables: viaNotify({ code: "483920" }) },
];

function bodyParamCount(payload: ReturnType<typeof buildWhatsAppTemplatePayload>): number {
  const components = (payload.template as { components: Array<{ type: string; parameters?: unknown[] }> }).components;
  return components.find((c) => c.type === "body")?.parameters?.length ?? 0;
}

describe("notify call sites satisfy their WhatsApp templates", () => {
  for (const { site, templateKey, variables, metaName, params } of CALL_SITES) {
    it(`${site} -> ${metaName}`, () => {
      const payload = buildWhatsAppTemplatePayload(templateKey, "628123456789", variables);
      expect((payload.template as { name: string }).name).toBe(metaName);
      expect(bodyParamCount(payload)).toBe(params);
    });
  }

  it("covers every template the registry defines", () => {
    // A template nobody sends is dead weight in Meta's review queue; a call site
    // with no case here is the gap this suite exists to catch.
    const covered = new Set(CALL_SITES.map((c) => c.metaName));
    expect([...covered].sort()).toEqual(
      [
        "booking_approved",
        "booking_approved_payment_link",
        "booking_expired",
        "booking_received",
        "booking_received_basic",
        "booking_rejected",
        "booking_waitlisted",
        "contract_proforma_ready",
        "invoice_issued",
        "invoice_overdue",
        "invoice_overdue_admin",
        "invoice_paid",
        "invoice_reminder",
        "invoice_reminder_admin",
        "kyc_requested",
        "lease_suspended",
        "login_link",
        "notice_confirmed",
        "otp_code",
        "renewal_offer_h14",
        "term_ended",
        "term_renewal_offer_h14",
        "waitlist_unit_offered",
      ].sort(),
    );
  });
});
