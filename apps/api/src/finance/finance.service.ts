import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  createCreditReplacementInvoice,
  generateFinalSettlement,
  generateInitialInvoice,
  generateNextCycleInvoice,
  markInvoicePaid,
  recordCreditNoteEntries,
  type BookingForInvoicing,
  type Prisma,
} from "@rentos/database";
import { invoiceFsm, money } from "@rentos/domain";

import { DocumentsService } from "../documents/documents.service.js";
import { PrismaService } from "../prisma/prisma.service.js";

/**
 * Thin NestJS wrapper — the actual invoice-generation logic lives in
 * @rentos/database (packages/database/src/invoicing.ts) specifically so
 * apps/worker's recurring-invoice/dunning jobs share the exact same code
 * path instead of a parallel implementation that could drift.
 */
@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly documents: DocumentsService,
  ) {}

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

  /**
   * PRD v2 P9 — the invoice/proforma PDF. Rendered on first request and
   * cached via `documentUrl`; re-rendered after payment so the document
   * says PAID (the cached proforma key is replaced). Returns the same
   * buffer-or-redirect shape every file endpoint uses.
   */
  async getInvoicePdf(tenant: { id: string; name: string; isPkp: boolean }, invoiceId: string) {
    const invoice = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.invoice.findUnique({
        where: { id: invoiceId },
        include: { lines: true, customer: true, booking: { include: { asset: true, assetType: true, location: true } } },
      }),
    );
    if (!invoice) throw new NotFoundException("Invoice not found.");
    const wantsPaidVersion = invoice.status === "PAID";
    const cachedIsFresh = invoice.documentUrl && (!wantsPaidVersion || invoice.documentUrl.endsWith("/paid.pdf"));
    if (invoice.documentUrl && cachedIsFresh) return this.documents.read(invoice.documentUrl);

    const tenantRow = await this.prisma.raw.tenant.findUniqueOrThrow({ where: { id: tenant.id }, select: { legalName: true } });
    const pdf = await this.documents.renderInvoice({
      tenant: { name: tenant.name, legalName: tenantRow.legalName, isPkp: tenant.isPkp },
      invoice: {
        ...invoice,
        subtotal: invoice.subtotal.toString(),
        taxAmount: invoice.taxAmount.toString(),
        totalAmount: invoice.totalAmount.toString(),
        lines: invoice.lines.map((l) => ({ description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), amount: l.amount.toString(), lineType: l.lineType })),
      },
      customer: invoice.customer,
      unit: invoice.booking
        ? { code: invoice.booking.asset?.code ?? null, assetTypeName: invoice.booking.assetType.name, locationName: invoice.booking.location?.name ?? null }
        : null,
    });
    const key = await this.documents.store(`invoices/${tenant.id}/${invoice.id}/${wantsPaidVersion ? "paid" : "proforma"}.pdf`, pdf);
    await this.prisma.runInTenantContext(tenant.id, (tx) => tx.invoice.update({ where: { id: invoiceId }, data: { documentUrl: key } }));
    return { kind: "buffer" as const, buffer: pdf, contentType: "application/pdf" };
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
}
