import { BadRequestException, Injectable } from "@nestjs/common";
import { bucketReceivables, money, roundMoney } from "@rentos/domain";
import type { ArAgingResponse } from "@rentos/contracts";

import { PrismaService } from "../prisma/prisma.service.js";

import type { CsvRow } from "./csv.util.js";

/** P0-basic reporting only (PRD §7.2.6) — occupancy % and AR aging buckets. RevPAU/cohorts/forecast are P1. */
@Injectable()
export class ReportingService {
  constructor(private readonly prisma: PrismaService) {}

  async occupancy(tenantId: string) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const [total, occupied] = await Promise.all([
        tx.asset.count({ where: { status: { not: "RETIRED" } } }),
        tx.asset.count({ where: { status: "OCCUPIED" } }),
      ]);
      return { totalAssets: total, occupiedAssets: occupied, occupancyRate: total === 0 ? 0 : occupied / total };
    });
  }

  /**
   * PRD v2 §5.2 — AR aging as of any date with a forward horizon: what's
   * overdue (by days past due) AND what's coming due in the next 30/60/90
   * days. SCHEDULED invoices (term payment schedules) are what make the
   * forward view real rather than a projection. The flat numeric buckets
   * the v1 reports page read are still returned for compatibility —
   * "current" there means due today or not yet due within the horizon,
   * matching the old point-in-time semantics.
   */
  async arAging(tenantId: string, asOf = new Date(), horizonDays = 30): Promise<ArAgingResponse> {
    if (Number.isNaN(asOf.getTime())) throw new BadRequestException("asOf must be a valid date.");
    const asOfDay = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const unpaid = await tx.invoice.findMany({
        where: { status: { in: ["ISSUED", "OVERDUE", "SCHEDULED"] } },
        select: { totalAmount: true, dueDate: true, status: true },
      });
      const buckets = bucketReceivables(unpaid, asOfDay, horizonDays);
      return {
        ...buckets,
        current: Number(buckets.overdue.current) + Number(buckets.comingDue.total),
        d1_30: Number(buckets.overdue.d1_30),
        d31_60: Number(buckets.overdue.d31_60),
        d60_plus: Number(buckets.overdue.d60_plus),
      };
    });
  }

  async bookingFunnel(tenantId: string) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const [requested, approved, active] = await Promise.all([
        tx.booking.count(),
        tx.booking.count({ where: { status: { in: ["APPROVED", "ACTIVE", "RENEWING", "SUSPENDED"] } } }),
        tx.booking.count({ where: { status: { in: ["ACTIVE", "RENEWING"] } } }),
      ]);
      return { requested, approved, active };
    });
  }

  /**
   * PRD §7.2.4: "Month-end close view: revenue recognized, deposits held,
   * AR, refunds." Revenue/refunds are period *flows* (net ledger movement
   * within the month); deposits held and AR are balance-sheet *snapshots*
   * as of the end of the month (cumulative movement from all time up to
   * that point) — the two shapes aren't interchangeable, so this computes
   * each the way its account actually behaves rather than uniformly
   * summing "this month's entries" for everything.
   */
  async monthEndClose(tenantId: string, year: number, month: number) {
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      throw new BadRequestException("month-end close requires a valid year and month (1-12).");
    }
    const periodStart = new Date(Date.UTC(year, month - 1, 1));
    const periodEnd = new Date(Date.UTC(year, month, 1));

    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const [inPeriod, uptoPeriodEnd] = await Promise.all([
        tx.ledgerEntry.findMany({
          where: { createdAt: { gte: periodStart, lt: periodEnd } },
          select: { account: true, entryType: true, amount: true },
        }),
        tx.ledgerEntry.findMany({
          where: { createdAt: { lt: periodEnd } },
          select: { account: true, entryType: true, amount: true },
        }),
      ]);

      // Credit-normal accounts (revenue/liabilities) grow on CREDIT; debit-normal
      // accounts (assets like AR) grow on DEBIT — netting must respect that or a
      // liability paydown would read as growth.
      const netBalance = (entries: typeof inPeriod, account: string, creditNormal: boolean) =>
        entries
          .filter((e) => e.account === account)
          .reduce((sum, e) => {
            const signed = e.entryType === "CREDIT" ? money(e.amount.toString()) : money(e.amount.toString()).negated();
            return sum.plus(creditNormal ? signed : signed.negated());
          }, money(0));

      const revenueRecognized = roundMoney(netBalance(inPeriod, "REVENUE", true));
      // Deposit refunds debit DEPOSIT_LIABILITY (paydown) — isolate just that
      // side rather than netting against collections, which would understate
      // "refunds paid out this month" whenever new deposits also came in.
      const depositRefundsThisMonth = roundMoney(
        inPeriod
          .filter((e) => e.account === "DEPOSIT_LIABILITY" && e.entryType === "DEBIT")
          .reduce((sum, e) => sum.plus(money(e.amount.toString())), money(0)),
      );
      const depositsHeld = roundMoney(netBalance(uptoPeriodEnd, "DEPOSIT_LIABILITY", true));
      const accountsReceivable = roundMoney(netBalance(uptoPeriodEnd, "ACCOUNTS_RECEIVABLE", false));
      const taxPayable = roundMoney(netBalance(uptoPeriodEnd, "TAX_PAYABLE", true));

      return {
        period: { year, month },
        revenueRecognized: revenueRecognized.toString(),
        depositsHeld: depositsHeld.toString(),
        accountsReceivable: accountsReceivable.toString(),
        refunds: depositRefundsThisMonth.toString(),
        taxPayable: taxPayable.toString(),
      };
    });
  }

  private dateRangeWhere(field: string, from?: Date, to?: Date) {
    if (!from && !to) return {};
    const range: Record<string, Date> = {};
    if (from) range.gte = from;
    if (to) range.lt = to;
    return { [field]: range };
  }

  /** PRD §7.2.4 "Exports: invoice/payment/ledger CSV" — Accurate/Jurnal-compatible formatting is P1, plain CSV is P0. */
  async exportInvoices(tenantId: string, from?: Date, to?: Date): Promise<CsvRow[]> {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const invoices = await tx.invoice.findMany({
        where: this.dateRangeWhere("issueDate", from, to),
        include: { customer: true },
        orderBy: { issueDate: "asc" },
      });
      return invoices.map((inv) => ({
        invoiceNumber: inv.invoiceNumber,
        status: inv.status,
        customer: inv.customer.fullName ?? inv.customer.phone,
        issueDate: inv.issueDate.toISOString(),
        dueDate: inv.dueDate.toISOString(),
        subtotal: inv.subtotal.toString(),
        taxAmount: inv.taxAmount.toString(),
        totalAmount: inv.totalAmount.toString(),
        supersededByInvoiceId: inv.supersededByInvoiceId,
      }));
    });
  }

  async exportPayments(tenantId: string, from?: Date, to?: Date): Promise<CsvRow[]> {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const payments = await tx.payment.findMany({
        where: this.dateRangeWhere("createdAt", from, to),
        include: { invoice: { select: { invoiceNumber: true } } },
        orderBy: { createdAt: "asc" },
      });
      return payments.map((p) => ({
        invoiceNumber: p.invoice.invoiceNumber,
        provider: p.provider,
        method: p.method,
        status: p.status,
        amount: p.amount.toString(),
        paidAt: p.paidAt ? p.paidAt.toISOString() : null,
        createdAt: p.createdAt.toISOString(),
      }));
    });
  }

  async exportLedger(tenantId: string, from?: Date, to?: Date): Promise<CsvRow[]> {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const entries = await tx.ledgerEntry.findMany({
        where: this.dateRangeWhere("createdAt", from, to),
        orderBy: { createdAt: "asc" },
      });
      return entries.map((e) => ({
        date: e.createdAt.toISOString(),
        account: e.account,
        entryType: e.entryType,
        amount: e.amount.toString(),
        currency: e.currency,
        referenceType: e.referenceType,
        referenceId: e.referenceId,
        description: e.description,
      }));
    });
  }
}
