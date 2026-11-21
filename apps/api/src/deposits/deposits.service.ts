import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  presetDates,
  ReportRangeError,
  resolveReportRange,
  zonedDateString,
  type DepositReport,
  type DepositReportQuery,
  type DepositReportRow,
  type DepositReportTotals,
  type ReportRange,
} from "@rentos/contracts";
import { money } from "@rentos/domain";
import {
  depositLeaseEnd,
  depositRemaining,
  recordDepositAppliedEntries,
  recordDepositEvent,
  recordDepositRefundedEntries,
} from "@rentos/database";

import { AuditService } from "../audit/audit.service.js";
import { PAYMENT_PROVIDER, type PaymentProvider } from "../payments/payment-provider.interface.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { csvAmount, csvDate, csvFilename, toCsv, type CsvRow } from "../reporting/csv.util.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

/** A stored calendar date (00:00 UTC) as YYYY-MM-DD, without shifting it a timezone. */
function calendarDate(at: Date | null | undefined): string | null {
  return at ? at.toISOString().slice(0, 10) : null;
}

const cents = (n: number) => Math.round(n * 100) / 100;
const str = (n: number) => cents(n).toFixed(2);

/** PRD go-live 2 §3.2 — one row per deposit, the columns of the page. */
export const DEPOSIT_CSV_COLUMNS = [
  "customer_number",
  "customer",
  "contract_number",
  "unit",
  "unit_type",
  "source",
  "amount",
  "received_date",
  "applied",
  "remaining",
  "status",
  "lease_end",
  "refund_due",
  "refund_overdue",
  "refund_requested_date",
  "refunded_date",
  "payout_reference",
  "held_at_end_of_range",
  "received_in_range",
  "applied_in_range",
  "refunded_in_range",
  "adjusted_in_range",
] as const;

/**
 * PRD §7.2.4: "held as liability... applied against damages/final
 * invoice, refund workflow with approval + disbursement." Two
 * independent things can happen to a HELD deposit, in either order or
 * combination: staff apply part of it against damages (`applyToDamages`),
 * and/or the remaining balance goes through request/approve refund. A
 * deposit is never refunded for more than `amount - appliedAmount` —
 * whatever's already been applied is gone for good.
 *
 * PRD go-live 2 §3: every one of those movements also writes a DepositEvent
 * in the same transaction as its ledger entries, and `report()` reads the
 * events to say what happened inside a date range.
 */
@Injectable()
export class DepositsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly audit: AuditService,
  ) {}

  listForBooking(tenantId: string, bookingId: string) {
    return this.prisma.runInTenantContext(tenantId, (tx) => tx.deposit.findMany({ where: { bookingId } }));
  }

  /** Console deposits queue (PRD §7.2.4 refund workflow) — filterable by status, e.g. ?status=REFUND_REQUESTED for the approval queue. */
  listAll(tenantId: string, filters: { status?: string }) {
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.deposit.findMany({
        where: { status: filters.status as never },
        include: { booking: { include: { customer: true, asset: true } } },
        orderBy: { createdAt: "desc" },
      }),
    );
  }

  /** The range a report runs over: the query's dates, or this month in the branch's timezone. */
  resolveRange(tenant: Pick<ResolvedTenant, "timezone">, query: Pick<DepositReportQuery, "from" | "to">): ReportRange {
    const timeZone = tenant.timezone || "Asia/Jakarta";
    if ((query.from && !query.to) || (!query.from && query.to)) {
      throw new BadRequestException("Give both from and to (YYYY-MM-DD), or neither.");
    }
    const dates = query.from && query.to ? { from: query.from, to: query.to } : presetDates("this_month", timeZone);
    try {
      return resolveReportRange(dates, timeZone);
    } catch (e) {
      if (e instanceof ReportRangeError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  /**
   * PRD go-live 2 §3.2 — the deposit report.
   *
   * Everything is derived from the deposit events: what a deposit held at any
   * instant is HELD + ADJUSTED − APPLIED − REFUNDED of the events before it.
   * The rows are the deposits still held at the end of the range plus those
   * that moved inside it; the filters narrow the rows and the totals over
   * them. The reconciliation is always the whole branch against the ledger.
   */
  async report(tenant: ResolvedTenant, query: DepositReportQuery, now: Date = new Date()): Promise<DepositReport> {
    const range = this.resolveRange(tenant, query);
    const today = zonedDateString(now, range.timeZone);

    const branch = await this.prisma.raw.tenant.findUniqueOrThrow({ where: { id: tenant.id }, select: { branchCode: true, slug: true } });

    const { deposits, ledger, unitTypes } = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const deposits = await tx.deposit.findMany({
        include: {
          events: { orderBy: { occurredAt: "asc" } },
          booking: {
            include: {
              customer: { select: { id: true, fullName: true, companyName: true, phone: true, customerNumber: true } },
              asset: { select: { code: true } },
              assetType: { select: { id: true, name: true } },
              contracts: { select: { contractNumber: true, createdAt: true }, orderBy: { createdAt: "desc" } },
            },
          },
        },
        orderBy: { receivedAt: "desc" },
      });
      const ledger = await tx.ledgerEntry.groupBy({
        by: ["entryType"],
        where: { account: "DEPOSIT_LIABILITY", createdAt: { lt: range.endExclusive } },
        _sum: { amount: true },
      });
      const unitTypes = await tx.assetType.findMany({ where: { archivedAt: null }, select: { id: true, name: true }, orderBy: { name: "asc" } });
      return { deposits, ledger, unitTypes };
    });

    let branchHeldAtEnd = 0;
    const rows: DepositReportRow[] = [];
    const sums = { heldAtEnd: 0, heldAtStart: 0, received: 0, applied: 0, refunded: 0, adjusted: 0, overdueCount: 0, overdueAmount: 0 };

    for (const d of deposits) {
      let heldAtStart = 0;
      let heldAtEnd = 0;
      let received = 0;
      let applied = 0;
      let refunded = 0;
      let adjusted = 0;
      let moved = false;
      for (const e of d.events) {
        const amount = Number(e.amount.toString());
        const signed = e.type === "HELD" || e.type === "ADJUSTED" ? amount : e.type === "APPLIED" || e.type === "REFUNDED" ? -amount : 0;
        if (e.occurredAt < range.start) heldAtStart += signed;
        if (e.occurredAt < range.endExclusive) heldAtEnd += signed;
        if (e.occurredAt >= range.start && e.occurredAt < range.endExclusive) {
          moved = true;
          if (e.type === "HELD") received += amount;
          else if (e.type === "APPLIED") applied += amount;
          else if (e.type === "REFUNDED") refunded += amount;
          else if (e.type === "ADJUSTED") adjusted += amount;
        }
      }
      heldAtEnd = cents(heldAtEnd);
      branchHeldAtEnd += heldAtEnd;

      // Not in this range at all: it neither moved in it nor was still held at its end.
      if (!moved && Math.abs(heldAtEnd) < 0.005) continue;

      const remaining = depositRemaining(d);
      const leaseEnd = calendarDate(depositLeaseEnd(d.booking));
      const refundDue = calendarDate(d.refundDueAt);
      const refundOverdue = Boolean(refundDue && refundDue < today && d.status !== "REFUNDED" && remaining > 0);

      if (query.status && d.status !== query.status) continue;
      if (query.assetTypeId && d.booking.assetTypeId !== query.assetTypeId) continue;
      if (query.source && d.source !== query.source) continue;
      if (query.refundOverdue && !refundOverdue) continue;
      if (query.movedOnly && !moved) continue;

      sums.heldAtEnd += heldAtEnd;
      sums.heldAtStart += heldAtStart;
      sums.received += received;
      sums.applied += applied;
      sums.refunded += refunded;
      sums.adjusted += adjusted;
      if (refundOverdue) {
        sums.overdueCount += 1;
        sums.overdueAmount += remaining;
      }

      const c = d.booking.customer;
      rows.push({
        id: d.id,
        bookingId: d.bookingId,
        customerId: c.id,
        customerName: c.companyName || c.fullName || c.phone || "—",
        customerNumber: c.customerNumber,
        contractNumber: d.booking.contracts.find((k) => k.contractNumber)?.contractNumber ?? null,
        unitCode: d.booking.asset?.code ?? null,
        unitTypeId: d.booking.assetType.id,
        unitTypeName: d.booking.assetType.name,
        source: d.source,
        amount: d.amount.toString(),
        appliedAmount: d.appliedAmount.toString(),
        remaining: str(remaining),
        status: d.status,
        receivedAt: d.receivedAt.toISOString(),
        leaseEnd,
        refundDue,
        refundOverdue,
        refundRequestedAt: d.refundRequestedAt?.toISOString() ?? null,
        refundedAt: d.refundedAt?.toISOString() ?? null,
        payoutRef: d.payoutRef,
        heldAtEnd: str(heldAtEnd),
        receivedInRange: str(received),
        appliedInRange: str(applied),
        refundedInRange: str(refunded),
        adjustedInRange: str(adjusted),
      });
    }

    const credit = Number(ledger.find((l) => l.entryType === "CREDIT")?._sum.amount?.toString() ?? 0);
    const debit = Number(ledger.find((l) => l.entryType === "DEBIT")?._sum.amount?.toString() ?? 0);
    const ledgerBalance = cents(credit - debit);
    const difference = cents(branchHeldAtEnd - ledgerBalance);

    const totals: DepositReportTotals = {
      heldAtEnd: str(sums.heldAtEnd),
      heldAtStart: str(sums.heldAtStart),
      receivedInRange: str(sums.received),
      appliedInRange: str(sums.applied),
      refundedInRange: str(sums.refunded),
      adjustedInRange: str(sums.adjusted),
      refundsOverdueCount: sums.overdueCount,
      refundsOverdueAmount: str(sums.overdueAmount),
      depositCount: rows.length,
    };

    return {
      range: { from: range.from, to: range.to },
      timeZone: range.timeZone,
      exportFilename: csvFilename(branch, "deposits", range),
      filtered: Boolean(query.status || query.assetTypeId || query.source || query.refundOverdue || query.movedOnly),
      totals,
      reconciliation: {
        heldAtEnd: str(branchHeldAtEnd),
        ledgerBalance: str(ledgerBalance),
        difference: str(difference),
        matches: Math.abs(difference) < 0.005,
      },
      unitTypes,
      rows,
    };
  }

  /** `deposits.csv` — the rows of the report, in the export conventions of PRD §2.4. */
  async exportCsv(tenant: ResolvedTenant, query: DepositReportQuery): Promise<{ filename: string; csv: string }> {
    const report = await this.report(tenant, query);
    const tz = report.timeZone;
    const rows: CsvRow[] = report.rows.map((r) => ({
      customer_number: r.customerNumber,
      customer: r.customerName,
      contract_number: r.contractNumber,
      unit: r.unitCode,
      unit_type: r.unitTypeName,
      source: r.source,
      amount: csvAmount(r.amount),
      received_date: csvDate(r.receivedAt, tz),
      applied: csvAmount(r.appliedAmount),
      remaining: csvAmount(r.remaining),
      status: r.status,
      lease_end: r.leaseEnd,
      refund_due: r.refundDue,
      refund_overdue: r.refundOverdue ? "yes" : "no",
      refund_requested_date: csvDate(r.refundRequestedAt, tz),
      refunded_date: csvDate(r.refundedAt, tz),
      payout_reference: r.payoutRef,
      held_at_end_of_range: csvAmount(r.heldAtEnd),
      received_in_range: csvAmount(r.receivedInRange),
      applied_in_range: csvAmount(r.appliedInRange),
      refunded_in_range: csvAmount(r.refundedInRange),
      adjusted_in_range: csvAmount(r.adjustedInRange),
    }));
    return { filename: report.exportFilename, csv: toCsv(rows, DEPOSIT_CSV_COLUMNS) };
  }

  /** PRD Appendix C RBAC: same bar as issuing credit notes (Super Admin, Finance Admin) — a unilateral deduction from customer funds. */
  async applyToDamages(tenant: ResolvedTenant, staffUserId: string, depositId: string, amount: string, reason: string) {
    const deposit = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.deposit.findUnique({ where: { id: depositId } }),
    );
    if (!deposit) throw new NotFoundException("Deposit not found.");
    if (deposit.status !== "HELD" && deposit.status !== "PARTIALLY_APPLIED") {
      throw new ConflictException(`Deposit is ${deposit.status}, cannot apply against damages.`);
    }

    const applyAmount = money(amount);
    const remaining = money(deposit.amount.toString()).minus(money(deposit.appliedAmount.toString()));
    if (applyAmount.lessThanOrEqualTo(0)) {
      throw new BadRequestException("Applied amount must be positive.");
    }
    if (applyAmount.greaterThan(remaining)) {
      throw new BadRequestException(`Cannot apply more than the remaining deposit balance (${remaining.toString()}).`);
    }

    const newAppliedAmount = money(deposit.appliedAmount.toString()).plus(applyAmount);
    const newStatus = newAppliedAmount.greaterThanOrEqualTo(money(deposit.amount.toString())) ? "APPLIED" : "PARTIALLY_APPLIED";

    const updated = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const result = await tx.deposit.update({
        where: { id: depositId },
        data: { appliedAmount: newAppliedAmount.toString(), status: newStatus },
      });
      await recordDepositAppliedEntries(tx, tenant.id, depositId, applyAmount.toString());
      await recordDepositEvent(tx, {
        tenantId: tenant.id,
        depositId,
        type: "APPLIED",
        amount: applyAmount.toString(),
        actorUserId: staffUserId,
        note: reason,
      });
      return result;
    });

    await this.audit.record({
      tenantId: tenant.id,
      actorUserId: staffUserId,
      action: "DEPOSIT_APPLIED",
      entityType: "Deposit",
      entityId: depositId,
      metadata: { amount: applyAmount.toString(), reason },
    });

    return updated;
  }

  async requestRefund(tenant: ResolvedTenant, depositId: string, requestedByUserId?: string) {
    const deposit = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.deposit.findUnique({ where: { id: depositId } }),
    );
    if (!deposit) throw new NotFoundException("Deposit not found.");
    if (deposit.status !== "HELD" && deposit.status !== "PARTIALLY_APPLIED") {
      throw new ConflictException(`Deposit is ${deposit.status}, cannot request refund.`);
    }
    const remaining = money(deposit.amount.toString()).minus(money(deposit.appliedAmount.toString()));
    if (remaining.lessThanOrEqualTo(0)) {
      throw new ConflictException("Nothing left to refund — the full deposit has been applied against damages.");
    }
    const requestedAt = new Date();
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const updated = await tx.deposit.update({
        where: { id: depositId },
        data: { status: "REFUND_REQUESTED", refundRequestedAt: requestedAt, refundRequestedByUserId: requestedByUserId ?? null },
      });
      // Moves no money — it is on the record so the report shows when the refund was asked for, and by whom.
      await recordDepositEvent(tx, {
        tenantId: tenant.id,
        depositId,
        type: "REFUND_REQUESTED",
        amount: remaining.toString(),
        occurredAt: requestedAt,
        actorUserId: requestedByUserId ?? null,
      });
      return updated;
    });
  }

  async approveRefund(tenant: ResolvedTenant, approverUserId: string, depositId: string) {
    const deposit = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.deposit.findUnique({ where: { id: depositId } }),
    );
    if (!deposit) throw new NotFoundException("Deposit not found.");
    if (deposit.status !== "REFUND_REQUESTED") {
      throw new ConflictException(`Deposit is ${deposit.status}, not awaiting refund approval.`);
    }

    // Only the unapplied remainder is ever refunded — whatever's already
    // been applied against damages doesn't come back.
    const refundAmount = money(deposit.amount.toString()).minus(money(deposit.appliedAmount.toString()));

    // Best-effort link back to the original payment for a real gateway
    // refund reference; MockPaymentProvider doesn't need this to be a real ref.
    const originalPayment = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.payment.findFirst({
        where: { status: "SUCCEEDED", invoice: { bookingId: deposit.bookingId, lines: { some: { lineType: "DEPOSIT" } } } },
        orderBy: { createdAt: "asc" },
      }),
    );

    const refundResult = await this.provider.refund(originalPayment?.providerRef ?? deposit.id, refundAmount);

    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const refundedAt = new Date();
      const updated = await tx.deposit.update({
        where: { id: depositId },
        data: {
          status: "REFUNDED",
          refundedAt,
          refundApprovedByUserId: approverUserId,
          payoutRef: refundResult.providerRef,
        },
      });
      await recordDepositRefundedEntries(tx, tenant.id, depositId, refundAmount.toString());
      await recordDepositEvent(tx, {
        tenantId: tenant.id,
        depositId,
        type: "REFUNDED",
        amount: refundAmount.toString(),
        occurredAt: refundedAt,
        actorUserId: approverUserId,
        note: refundResult.providerRef ? `Payout ${refundResult.providerRef}` : null,
      });
      return updated;
    });
  }
}
