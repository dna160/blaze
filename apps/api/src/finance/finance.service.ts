import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  generateFinalSettlement,
  generateInitialInvoice,
  generateNextCycleInvoice,
  markInvoicePaid,
  recordCreditNoteEntries,
  type BookingForInvoicing,
  type Prisma,
} from "@rentos/database";
import { invoiceFsm } from "@rentos/domain";

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
   * PRD §7.2.4: "corrections happen via credit note, never edit-in-place."
   * v1 scope: marks the invoice CREDITED and records the ledger reversal.
   * Issuing a replacement invoice for the corrected amount (if one is
   * needed) is a separate, manual follow-up action today — the PRD's
   * "superseded by CREDIT_NOTE + new invoice" isn't auto-wired yet
   * (tracked in docs/HANDOFF.md).
   */
  async createCreditNote(tenantId: string, issuedByUserId: string, invoiceId: string, amount: string, reason: string) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } });
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
      return creditNote;
    });
  }

  listCreditNotesForInvoice(tenantId: string, invoiceId: string) {
    return this.prisma.runInTenantContext(tenantId, (tx) => tx.creditNote.findMany({ where: { invoiceId } }));
  }
}
