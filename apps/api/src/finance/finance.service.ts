import { Injectable, NotFoundException } from "@nestjs/common";
import {
  generateFinalSettlement,
  generateInitialInvoice,
  generateNextCycleInvoice,
  markInvoicePaid,
  type BookingForInvoicing,
  type Prisma,
} from "@rentos/database";

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
}
