import {
  computeCreditReplacementDraft,
  getBookingModelStrategy,
  invoiceFsm,
  money,
  type BookingWindow,
  type InvoiceDraft,
  type InvoiceSnapshot,
  type PricingConfig,
  type SeasonalRate,
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
  /** NIGHTLY checkout date, or RECURRING_LEASE fixed-term (DAILY/WEEKLY rateTier) end date — unused otherwise. */
  endDate?: Date | null;
  anchorDay: number | null;
  /** RECURRING_LEASE only — see @rentos/domain RateTier. Ignored for other booking models. */
  rateTier?: "DAILY" | "WEEKLY" | "MONTHLY";
  priceSnapshot: unknown;
}

export function toPricingConfig(priceSnapshot: unknown): PricingConfig {
  const p = priceSnapshot as {
    basePrice: number;
    currency: string;
    adminFee?: number;
    depositRule?: { type: "FIXED"; amount: number } | { type: "MULTIPLE_OF_RENT"; multiple: number };
    prorationRule?: "ANCHOR_DATE" | "FULL_FIRST_PERIOD";
    taxInclusive?: boolean;
    seasonalRates?: SeasonalRate[];
    dailyRate?: number;
    weeklyRate?: number;
  };
  return {
    basePrice: money(p.basePrice),
    currency: p.currency,
    adminFee: p.adminFee !== undefined ? money(p.adminFee) : undefined,
    depositRule: p.depositRule,
    prorationRule: p.prorationRule,
    taxInclusive: p.taxInclusive ?? false,
    seasonalRates: p.seasonalRates,
    dailyRate: p.dailyRate !== undefined ? money(p.dailyRate) : undefined,
    weeklyRate: p.weeklyRate !== undefined ? money(p.weeklyRate) : undefined,
  };
}

function dueDateFor(issueDate: Date): Date {
  const due = new Date(issueDate);
  due.setDate(due.getDate() + 7);
  return due;
}

interface InvoiceOwner {
  bookingId: string | null;
  customerId: string;
}

async function persistInvoiceCore(
  tx: Prisma.TransactionClient,
  tenantId: string,
  tenantSlug: string,
  owner: InvoiceOwner,
  draft: InvoiceDraft,
) {
  const invoiceNumber = await nextInvoiceNumber(tx, tenantId, tenantSlug);
  const issueDate = new Date();
  const { to: status } = await invoiceFsm.fire("SCHEDULED", "ISSUE", undefined);

  const invoice = await tx.invoice.create({
    data: {
      tenantId,
      bookingId: owner.bookingId,
      customerId: owner.customerId,
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

function persistInvoice(
  tx: Prisma.TransactionClient,
  tenantId: string,
  tenantSlug: string,
  booking: BookingForInvoicing,
  draft: InvoiceDraft,
) {
  return persistInvoiceCore(tx, tenantId, tenantSlug, { bookingId: booking.id, customerId: booking.customerId }, draft);
}

export interface InvoiceLineForCredit {
  description: string;
  amount: string;
  lineType: string;
}

export interface InvoiceForCredit {
  bookingId: string | null;
  customerId: string;
  totalAmount: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  lines: InvoiceLineForCredit[];
}

/**
 * PRD §8.2: an invoice "superseded by CREDIT_NOTE + new invoice". Only
 * called for a *partial* credit — the caller skips this entirely when the
 * credit note covers the full invoice total, since there's no remaining
 * balance to bill (see FinanceService.createCreditNote).
 */
export async function createCreditReplacementInvoice(
  tx: Prisma.TransactionClient,
  tenantId: string,
  tenantSlug: string,
  original: InvoiceForCredit,
  creditAmount: string,
) {
  const draft = computeCreditReplacementDraft(
    {
      lines: original.lines.map((l) => ({ description: l.description, amount: l.amount, lineType: l.lineType as never })),
      totalAmount: original.totalAmount,
      periodStart: original.periodStart,
      periodEnd: original.periodEnd,
    } satisfies InvoiceSnapshot,
    creditAmount,
  );
  return persistInvoiceCore(tx, tenantId, tenantSlug, { bookingId: original.bookingId, customerId: original.customerId }, draft);
}

export async function generateInitialInvoice(
  tx: Prisma.TransactionClient,
  tenantId: string,
  tenantSlug: string,
  isTenantPkp: boolean,
  booking: BookingForInvoicing,
) {
  const strategy = getBookingModelStrategy(booking.bookingModel);
  const window: BookingWindow = {
    startDate: booking.startDate,
    endDate: booking.endDate ?? undefined,
    rateTier: booking.rateTier,
  };
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
