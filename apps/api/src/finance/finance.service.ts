import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  createCreditReplacementInvoice,
  generateFinalSettlement,
  generateInitialInvoice,
  generateNextCycleInvoice,
  markInvoicePaid,
  recordCreditNoteEntries,
  recordInvoiceVoidedEntries,
  type BookingForInvoicing,
  type Prisma,
} from "@rentos/database";
import { invoiceFsm, money } from "@rentos/domain";

import { PrismaService } from "../prisma/prisma.service.js";

/**
 * Thin NestJS wrapper — the actual invoice-generation logic lives in
 * @rentos/database (packages/database/src/invoicing.ts) specifically so
 * apps/worker's recurring-invoice/dunning jobs share the exact same code
 * path instead of a parallel implementation that could drift.
 */
@Injectable()
export class FinanceService {
  constructor(private readonly prisma: PrismaService) {}

  generateInitialInvoice(
    tx: Prisma.TransactionClient,
    tenantId: string,
    tenantSlug: string,
    isTenantPkp: boolean,
    booking: BookingForInvoicing,
  ) {
    return generateInitialInvoice(tx, tenantId, tenantSlug, isTenantPkp, booking);
  }

  generateNextCycleInvoice(
    tx: Prisma.TransactionClient,
    tenantId: string,
    tenantSlug: string,
    isTenantPkp: boolean,
    booking: BookingForInvoicing,
    cycleStart: Date,
  ) {
    return generateNextCycleInvoice(tx, tenantId, tenantSlug, isTenantPkp, booking, cycleStart);
  }

  generateFinalSettlement(
    tx: Prisma.TransactionClient,
    tenantId: string,
    tenantSlug: string,
    isTenantPkp: boolean,
    booking: BookingForInvoicing,
    effectiveEndDate: Date,
  ) {
    return generateFinalSettlement(tx, tenantId, tenantSlug, isTenantPkp, booking, effectiveEndDate);
  }

  markPaid(tx: Prisma.TransactionClient, invoiceId: string) {
    return markInvoicePaid(tx, invoiceId);
  }

  async getInvoice(tenantId: string, invoiceId: string) {
    const invoice = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.invoice.findUnique({ where: { id: invoiceId }, include: { lines: true, payments: true } }),
    );
    if (!invoice) throw new NotFoundException("Invoice not found.");
    return invoice;
  }

  listInvoicesForCustomer(tenantId: string, customerId: string) {
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.invoice.findMany({ where: { customerId }, include: { lines: true }, orderBy: { issueDate: "desc" } }),
    );
  }

  listInvoices(tenantId: string, filters: { status?: string }) {
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.invoice.findMany({
        where: { status: filters.status as never },
        include: { lines: true },
        orderBy: { issueDate: "desc" },
      }),
    );
  }

  /**
   * PRD §7.2.4/§8.2: "corrections happen via credit note, never
   * edit-in-place"; a corrected invoice is "superseded by CREDIT_NOTE +
   * new invoice". Marks the original invoice CREDITED, records the ledger
   * reversal, and — when the credit is partial (there's still a balance
   * owed) — issues a fresh replacement invoice for exactly that remaining
   * amount, linked back via `supersededByInvoiceId`. A full credit (amount
   * === total) has nothing left to bill, so no replacement is issued.
   */
  async createCreditNote(
    tenant: { id: string; slug: string },
    issuedByUserId: string,
    invoiceId: string,
    amount: string,
    reason: string,
  ) {
    const tenantId = tenant.id;
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const invoice = await tx.invoice.findUnique({ where: { id: invoiceId }, include: { lines: true } });
      if (!invoice) throw new NotFoundException("Invoice not found.");
      if (Number(amount) <= 0 || Number(amount) > Number(invoice.totalAmount.toString())) {
        throw new BadRequestException("Credit note amount must be positive and not exceed the invoice total.");
      }
      if (invoice.status !== "ISSUED" && invoice.status !== "OVERDUE") {
        throw new ConflictException(`Invoice is ${invoice.status} — only ISSUED/OVERDUE invoices can be credited.`);
      }

      const { to: status } = await invoiceFsm.fire(invoice.status, "ADJUST", undefined);
      await tx.invoice.update({ where: { id: invoiceId }, data: { status } });

      const creditNote = await tx.creditNote.create({
        data: { tenantId, invoiceId, amount, reason, issuedByUserId },
      });
      await recordCreditNoteEntries(tx, tenantId, creditNote.id, invoiceId, amount);

      const remaining = money(invoice.totalAmount.toString()).minus(money(amount));
      if (remaining.greaterThan(0)) {
        const replacement = await createCreditReplacementInvoice(
          tx,
          tenantId,
          tenant.slug,
          {
            bookingId: invoice.bookingId,
            customerId: invoice.customerId,
            totalAmount: invoice.totalAmount.toString(),
            periodStart: invoice.periodStart,
            periodEnd: invoice.periodEnd,
            lines: invoice.lines.map((l) => ({ description: l.description, amount: l.amount.toString(), lineType: l.lineType })),
          },
          amount,
        );
        await tx.invoice.update({ where: { id: invoiceId }, data: { supersededByInvoiceId: replacement.id } });
      }

      return creditNote;
    });
  }

  listCreditNotesForInvoice(tenantId: string, invoiceId: string) {
    return this.prisma.runInTenantContext(tenantId, (tx) => tx.creditNote.findMany({ where: { invoiceId } }));
  }

  /**
   * BUILD-SPEC #33 — void an UNPAID invoice (SPV-gated via the void_invoice
   * capability). Reverses exactly the issue entries so the ledger stays balanced,
   * stamps who/why, and writes an immutable audit log row. The client named
   * "invoice pile-up" as a live pain — this is the clean exit for a wrong invoice.
   */
  async voidInvoice(tenant: { id: string }, userId: string, invoiceId: string, reason: string) {
    if (!reason?.trim()) throw new BadRequestException("A void reason is required.");
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
      if (!invoice) throw new NotFoundException("Invoice not found.");
      if (!["SCHEDULED", "ISSUED", "OVERDUE"].includes(invoice.status)) {
        throw new ConflictException(`Invoice is ${invoice.status} — only an unpaid invoice can be voided (use a credit note for a paid one).`);
      }
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: "VOID", voidedAt: new Date(), voidedByUserId: userId, voidReason: reason },
      });
      await recordInvoiceVoidedEntries(tx, tenant.id, invoiceId);
      await tx.auditLog.create({
        data: { tenantId: tenant.id, actorUserId: userId, action: "INVOICE_VOID", entityType: "Invoice", entityId: invoiceId, metadata: { reason } },
      });
      return { id: invoiceId, status: "VOID" };
    });
  }

  /**
   * BUILD-SPEC #32 — manual per-order price override (SPV-gated via price_override).
   * The client's real rates are 4.5/5/6% then HAND-ROUNDED, so rules alone never
   * reproduce their quotes. Records the hand-rounded monthly rate on the order's
   * price snapshot (generateRentalOrderInvoice reads overrideMonthlyRate) and
   * audit-logs it. Applies to the order's FUTURE invoices, not ones already issued.
   */
  async overrideRentalOrderPrice(
    tenant: { id: string },
    userId: string,
    rentalOrderId: string,
    overrideMonthlyRate: number,
    reason: string,
  ) {
    if (!(overrideMonthlyRate > 0)) throw new BadRequestException("overrideMonthlyRate must be positive.");
    if (!reason?.trim()) throw new BadRequestException("An override reason is required.");
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const order = await tx.rentalOrder.findUnique({ where: { id: rentalOrderId } });
      if (!order) throw new NotFoundException("Rental order not found.");
      const snapshot = { ...(order.priceSnapshot as Record<string, unknown>), overrideMonthlyRate };
      await tx.rentalOrder.update({ where: { id: rentalOrderId }, data: { priceSnapshot: snapshot } });
      await tx.auditLog.create({
        data: {
          tenantId: tenant.id,
          actorUserId: userId,
          action: "PRICE_OVERRIDE",
          entityType: "RentalOrder",
          entityId: rentalOrderId,
          metadata: { overrideMonthlyRate, reason },
        },
      });
      return { id: rentalOrderId, overrideMonthlyRate };
    });
  }
}
