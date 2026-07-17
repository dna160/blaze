import {
  getBookingModelStrategy,
  invoiceFsm,
  money,
  type BookingWindow,
  type InvoiceDraft,
  type PricingConfig,
} from "@rentos/domain";

import type { Prisma } from "../generated/client/index.js";
import { nextInvoiceNumber } from "./invoice-number.js";
import { recordInvoiceIssuedEntries } from "./ledger.js";

/**
 * Shared invoice-generation orchestration — combines @rentos/domain's pure
 * BookingModelStrategy math with the Prisma writes needed to persist an
 * Invoice. Lives in @rentos/database (not apps/api) specifically so
 * apps/worker's recurring-invoice/dunning jobs can call the exact same
 * code path the API uses on booking approval, instead of a second
 * hand-rolled copy drifting out of sync with it.
 */

export interface BookingForInvoicing {
  id: string;
  bookingModel: "RECURRING_LEASE" | "NIGHTLY" | "DURATION_ORDER" | "HOURLY_SLOT";
  customerId: string;
  startDate: Date;
  anchorDay: number | null;
  priceSnapshot: unknown;
}

function toPricingConfig(priceSnapshot: unknown): PricingConfig {
  const p = priceSnapshot as {
    basePrice: number;
    currency: string;
    adminFee?: number;
    depositRule?: { type: "FIXED"; amount: number } | { type: "MULTIPLE_OF_RENT"; multiple: number };
    prorationRule?: "ANCHOR_DATE" | "FULL_FIRST_PERIOD";
    taxInclusive?: boolean;
  };
  return {
    basePrice: money(p.basePrice),
    currency: p.currency,
    adminFee: p.adminFee !== undefined ? money(p.adminFee) : undefined,
    depositRule: p.depositRule,
    prorationRule: p.prorationRule,
    taxInclusive: p.taxInclusive ?? false,
  };
}

function dueDateFor(issueDate: Date): Date {
  const due = new Date(issueDate);
  due.setDate(due.getDate() + 7);
  return due;
}

async function persistInvoice(
  tx: Prisma.TransactionClient,
  tenantId: string,
  tenantSlug: string,
  booking: BookingForInvoicing,
  draft: InvoiceDraft,
) {
  const invoiceNumber = await nextInvoiceNumber(tx, tenantId, tenantSlug);
  const issueDate = new Date();
  const { to: status } = await invoiceFsm.fire("SCHEDULED", "ISSUE", undefined);

  const invoice = await tx.invoice.create({
    data: {
      tenantId,
      bookingId: booking.id,
      customerId: booking.customerId,
      invoiceNumber,
      status,
      currency: "IDR",
      subtotal: draft.subtotal.toString(),
      taxAmount: draft.taxAmount.toString(),
      totalAmount: draft.totalAmount.toString(),
      issueDate,
      dueDate: dueDateFor(issueDate),
      periodStart: draft.periodStart,
      periodEnd: draft.periodEnd,
      lines: {
        create: draft.lines.map((l) => ({
          tenantId,
          description: l.description,
          quantity: l.quantity.toString(),
          unitPrice: l.unitPrice.toString(),
          amount: l.amount.toString(),
          lineType: l.lineType,
        })),
      },
    },
    include: { lines: true },
  });

  // Revenue is recognized at issue (accrual), deposit lines excluded — they're
  // a liability, never revenue/AR (see ledger.ts header comment).
  const revenueAmount = draft.lines
    .filter((l) => l.lineType !== "DEPOSIT" && l.lineType !== "TAX")
    .reduce((sum, l) => sum + Number(l.amount.toString()), 0)
    .toFixed(2);
  await recordInvoiceIssuedEntries(tx, tenantId, invoice.id, invoiceNumber, revenueAmount, draft.taxAmount.toString());

  return invoice;
}

export async function generateInitialInvoice(
  tx: Prisma.TransactionClient,
  tenantId: string,
  tenantSlug: string,
  isTenantPkp: boolean,
  booking: BookingForInvoicing,
) {
  const strategy = getBookingModelStrategy(booking.bookingModel);
  const window: BookingWindow = { startDate: booking.startDate };
  const draft = strategy.computeInitialInvoice(window, toPricingConfig(booking.priceSnapshot), { isTenantPkp });
  return persistInvoice(tx, tenantId, tenantSlug, booking, draft);
}

export async function generateNextCycleInvoice(
  tx: Prisma.TransactionClient,
  tenantId: string,
  tenantSlug: string,
  isTenantPkp: boolean,
  booking: BookingForInvoicing,
  cycleStart: Date,
) {
  const strategy = getBookingModelStrategy(booking.bookingModel);
  if (!strategy.computeNextCycleInvoice) {
    throw new Error(`${booking.bookingModel} does not support recurring cycle invoices.`);
  }
  const draft = strategy.computeNextCycleInvoice(cycleStart, toPricingConfig(booking.priceSnapshot), { isTenantPkp });
  return persistInvoice(tx, tenantId, tenantSlug, booking, draft);
}

export async function generateFinalSettlement(
  tx: Prisma.TransactionClient,
  tenantId: string,
  tenantSlug: string,
  isTenantPkp: boolean,
  booking: BookingForInvoicing,
  effectiveEndDate: Date,
) {
  const strategy = getBookingModelStrategy(booking.bookingModel);
  const window: BookingWindow = { startDate: booking.startDate, anchorDay: booking.anchorDay ?? undefined };
  const draft = strategy.computeFinalSettlement(window, toPricingConfig(booking.priceSnapshot), { isTenantPkp }, effectiveEndDate);
  return persistInvoice(tx, tenantId, tenantSlug, booking, draft);
}

export async function markInvoicePaid(tx: Prisma.TransactionClient, invoiceId: string) {
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const { to: status } = await invoiceFsm.fire(invoice.status as never, "PAYMENT_RECEIVED", undefined);
  return tx.invoice.update({ where: { id: invoiceId }, data: { status, paidAt: new Date() } });
}

export async function markInvoiceOverdue(tx: Prisma.TransactionClient, invoiceId: string) {
  const invoice = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  if (invoice.status !== "ISSUED") return invoice;
  const { to: status } = await invoiceFsm.fire("ISSUED", "DUE_DATE_PASSED", undefined);
  return tx.invoice.update({ where: { id: invoiceId }, data: { status } });
}
