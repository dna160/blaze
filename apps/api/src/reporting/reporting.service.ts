import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { bucketReceivables, classifyReceivable, money, roundMoney } from "@rentos/domain";
import {
  daysInRange,
  presetDates,
  rangeBucket,
  ReportRangeError,
  resolveReportRange,
  zonedDateString,
  zonedDateTimeString,
  zonedStartOfDay,
  type ArAgingResponse,
  type ArAgingRow,
  type FinancialSummaryResponse,
  type LedgerAccountSummary,
  type MonthEndCloseResponse,
  type ReportBranchInfo,
  type ReportRange,
  type SalesGroupBy,
  type SalesPeriodRow,
  type SalesReportResponse,
  type SalesTransactionRow,
  type SalesTransactionStatus,
} from "@rentos/contracts";

import { CrmService } from "../crm/crm.service.js";
import { PrismaService } from "../prisma/prisma.service.js";

import { csvAmount, csvDate, csvDateTime, type CsvRow } from "./csv.util.js";

/** What a report needs to know about the branch it is run for. */
export interface ReportBranch {
  id: string;
  slug: string;
  name: string;
  branchCode: string | null;
  timeZone: string;
  isPkp: boolean;
}

export interface CsvExport {
  rows: CsvRow[];
  columns: string[];
}

type D = ReturnType<typeof money>;

/** The side each ledger account grows on. Balances are reported positive on that side. */
const NORMAL_SIDE: Record<string, "DEBIT" | "CREDIT"> = {
  ACCOUNTS_RECEIVABLE: "DEBIT",
  CASH: "DEBIT",
  PREPAID_TAX_PPH: "DEBIT",
  REFUND: "DEBIT",
  REVENUE: "CREDIT",
  TAX_PAYABLE: "CREDIT",
  DEPOSIT_LIABILITY: "CREDIT",
  OPENING_BALANCE: "CREDIT",
};
const ACCOUNT_ORDER = ["CASH", "ACCOUNTS_RECEIVABLE", "PREPAID_TAX_PPH", "REVENUE", "TAX_PAYABLE", "DEPOSIT_LIABILITY", "REFUND", "OPENING_BALANCE"];

/** A payment counts as received once it reached SUCCEEDED; a later refund does not un-receive it. */
const RECEIVED_STATUSES = ["SUCCEEDED", "PARTIALLY_REFUNDED", "REFUNDED"] as const;
/** An invoice that was really billed: not a future schedule row, not voided, not replaced by a credit note. */
const NOT_SALES_STATUSES = ["SCHEDULED", "VOID", "CREDITED"] as const;
/** Bookings that never became a rental do not count as "started". */
const NOT_STARTED_STATUSES = ["DRAFT", "WAITLISTED", "PENDING_APPROVAL", "NEEDS_INFO", "APPROVED", "REJECTED", "EXPIRED", "LAPSED", "NO_SHOW"] as const;
const ENDED_STATUSES = ["MOVED_OUT", "CHECKED_OUT", "RETURNED"] as const;
const PAYMENT_METHODS = ["VIRTUAL_ACCOUNT", "QRIS", "EWALLET", "CARD", "MANUAL_TRANSFER", "CASH"] as const;

const sum = (values: Array<{ toString(): string } | null | undefined>): D =>
  values.reduce<D>((acc, v) => (v === null || v === undefined ? acc : acc.plus(money(v.toString()))), money(0));
const str = (d: D): string => roundMoney(d).toString();

/**
 * Reporting (PRD §7.2.6, PRD go-live 2 §2).
 *
 * One convention for time: every report and export takes `from`/`to` as
 * inclusive calendar dates in the BRANCH's timezone and filters on the
 * half-open instant window `resolveReportRange` returns. Nothing here does
 * month arithmetic in UTC any more — a payment at 06:30 WIB on 1 November
 * (23:30 UTC on 31 October) is November's.
 */
@Injectable()
export class ReportingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crm: CrmService,
  ) {}

  // ── Branch + range ────────────────────────────────────────────────────────

  async branch(tenantId: string): Promise<ReportBranch> {
    const t = await this.prisma.raw.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true, name: true, branchCode: true, timezone: true, isPkp: true },
    });
    if (!t) throw new NotFoundException("Branch not found.");
    return { id: t.id, slug: t.slug, name: t.name, branchCode: t.branchCode, timeZone: t.timezone || "Asia/Jakarta", isPkp: t.isPkp };
  }

  private branchInfo(b: ReportBranch): ReportBranchInfo {
    return { code: b.branchCode || b.slug, name: b.name, isPkp: b.isPkp };
  }

  /** `from`/`to` (inclusive, branch timezone) -> the instant window. Both missing = this month. */
  rangeFor(b: ReportBranch, from?: string, to?: string): ReportRange {
    if (!from && !to) return resolveReportRange(presetDates("this_month", b.timeZone), b.timeZone);
    if (!from || !to) throw new BadRequestException("Give both from and to (YYYY-MM-DD), or neither.");
    try {
      return resolveReportRange({ from, to }, b.timeZone);
    } catch (e) {
      if (e instanceof ReportRangeError) throw new BadRequestException(e.message);
      throw e;
    }
  }

  /** For exports: no dates at all means "everything" (null); otherwise the same rules as `rangeFor`. */
  optionalRange(b: ReportBranch, from?: string, to?: string): ReportRange | null {
    return !from && !to ? null : this.rangeFor(b, from, to);
  }

  private within(range: ReportRange | null) {
    return range ? { gte: range.start, lt: range.endExclusive } : undefined;
  }

  // ── Occupancy / funnel (unchanged, point-in-time) ─────────────────────────

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
   * BUILD-SPEC #47 — the forward-occupancy calendar ("which units are empty next
   * month"), the client's favourite screen in the old system. For a target month,
   * per asset type: total units, how many are held by a rental order overlapping
   * that month, and how many are free. #17: an order counts as occupying while it
   * is ACTIVE or RENEWAL_OFFERED (a unit is NOT free until non-renewal is
   * confirmed), as well as while it is being approved/paid.
   */
  async forwardOccupancy(tenantId: string, year?: number, month?: number) {
    const b = await this.branch(tenantId);
    // Default: the month after the branch's current one.
    const today = zonedDateString(new Date(), b.timeZone);
    const ty = Number(today.slice(0, 4));
    const tm = Number(today.slice(5, 7));
    const y = year ?? (tm === 12 ? ty + 1 : ty);
    const m = month ?? (tm % 12) + 1;
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
      throw new BadRequestException("year and month must be valid integers (month 1–12).");
    }
    const first = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`;
    const next = m === 12 ? `${String(y + 1).padStart(4, "0")}-01-01` : `${String(y).padStart(4, "0")}-${String(m + 1).padStart(2, "0")}-01`;
    const monthStart = zonedStartOfDay(first, b.timeZone);
    const monthEnd = zonedStartOfDay(next, b.timeZone);
    const OCCUPYING = ["APPROVED", "AWAITING_PAYMENT", "ACTIVE", "RENEWAL_OFFERED", "RENEWAL_CONFIRMED", "EXPIRING"] as const;

    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const assetTypes = await tx.assetType.findMany({ orderBy: { name: "asc" } });
      const rows = [];
      for (const at of assetTypes) {
        const totalUnits = await tx.asset.count({ where: { assetTypeId: at.id, status: { not: "RETIRED" } } });
        // Distinct units held by an overlapping, occupying order.
        const orders = await tx.rentalOrder.findMany({
          where: {
            assetTypeId: at.id,
            assetId: { not: null },
            status: { in: [...OCCUPYING] },
            periodStart: { lt: monthEnd },
            periodEnd: { gt: monthStart },
          },
          select: { assetId: true },
          distinct: ["assetId"],
        });
        const occupied = orders.length;
        rows.push({
          assetTypeId: at.id,
          assetType: at.name,
          totalUnits,
          occupiedNextPeriod: occupied,
          freeNextPeriod: Math.max(0, totalUnits - occupied),
        });
      }
      return { month: `${y}-${String(m).padStart(2, "0")}`, assetTypes: rows };
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

  // ── §2.5 AR aging, with the invoices behind every bucket ──────────────────

  /**
   * AR aging as of a branch-calendar date with a forward horizon (§5.2): what
   * is overdue (bucketed by days past due) AND what comes due in the next
   * 30/60/90 days. SCHEDULED invoices are what make the forward half real
   * rather than a projection.
   *
   * Days are counted between CALENDAR dates in the branch's timezone, so an
   * invoice due "today" in Jakarta is not a day overdue because the server's
   * clock is in UTC. `rows` (go-live 2 §2.5) lists every invoice with the
   * bucket it was counted in — the same `classifyReceivable` rule produces
   * both, so a bucket always equals the sum of its rows.
   */
  async arAging(tenantId: string, asOfDate?: string, horizonDays = 30): Promise<ArAgingResponse> {
    const b = await this.branch(tenantId);
    const asOf = asOfDate || zonedDateString(new Date(), b.timeZone);
    const asOfRange = this.rangeFor(b, asOf, asOf);
    const utcDay = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
    const asOfDay = utcDay(asOfRange.from);

    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const unpaid = await tx.invoice.findMany({
        where: { status: { in: ["ISSUED", "OVERDUE", "SCHEDULED"] } },
        select: {
          id: true,
          invoiceNumber: true,
          totalAmount: true,
          dueDate: true,
          status: true,
          customer: { select: { id: true, fullName: true, companyName: true, phone: true, customerNumber: true } },
          booking: { select: { asset: { select: { code: true } }, contracts: { orderBy: { createdAt: "desc" }, take: 1, select: { contractNumber: true } } } },
          rentalOrder: { select: { asset: { select: { code: true } }, contracts: { orderBy: { createdAt: "desc" }, take: 1, select: { contractNumber: true } } } },
        },
        orderBy: [{ dueDate: "asc" }, { invoiceNumber: "asc" }],
      });

      // Each due date as a calendar day in the branch's timezone.
      const dated = unpaid.map((inv) => ({ inv, dueYmd: zonedDateString(inv.dueDate, b.timeZone) }));
      const buckets = bucketReceivables(
        dated.map(({ inv, dueYmd }) => ({ totalAmount: inv.totalAmount.toString(), dueDate: utcDay(dueYmd), status: inv.status })),
        asOfDay,
        horizonDays,
      );

      // The latest reminder that actually went out, per invoice (never a suppressed or failed one).
      const reminders = await tx.notification.findMany({
        where: {
          recipientRole: "CUSTOMER",
          status: { notIn: ["SUPPRESSED", "FAILED", "QUEUED"] },
          OR: [{ templateKey: { startsWith: "invoice_reminder_" } }, { templateKey: { startsWith: "invoice_overdue_" } }],
        },
        select: { templateKey: true, payload: true, sentAt: true, createdAt: true },
        orderBy: { createdAt: "asc" },
      });
      const lastReminder = new Map<string, { at: Date; templateKey: string }>();
      for (const n of reminders) {
        const invoiceId = (n.payload as { invoiceId?: unknown } | null)?.invoiceId;
        if (typeof invoiceId === "string") lastReminder.set(invoiceId, { at: n.sentAt ?? n.createdAt, templateKey: n.templateKey });
      }

      const rows: ArAgingRow[] = dated.map(({ inv, dueYmd }) => {
        const daysOverdue = Math.round((asOfDay.getTime() - utcDay(dueYmd).getTime()) / 86_400_000);
        const owner = inv.rentalOrder ?? inv.booking;
        const reminder = lastReminder.get(inv.id);
        return {
          invoiceId: inv.id,
          bucket: classifyReceivable(daysOverdue, horizonDays),
          customerId: inv.customer.id,
          customer: inv.customer.fullName ?? inv.customer.companyName ?? inv.customer.phone,
          customerNumber: inv.customer.customerNumber,
          contractNumber: owner?.contracts[0]?.contractNumber ?? null,
          invoiceNumber: inv.invoiceNumber,
          unit: owner?.asset?.code ?? null,
          dueDate: dueYmd,
          daysOverdue,
          amountOutstanding: roundMoney(money(inv.totalAmount.toString())).toString(),
          status: inv.status,
          lastReminderAt: reminder ? reminder.at.toISOString() : null,
          lastReminderTemplate: reminder?.templateKey ?? null,
        };
      });

      return {
        ...buckets,
        current: Number(buckets.overdue.current) + Number(buckets.comingDue.total),
        d1_30: Number(buckets.overdue.d1_30),
        d31_60: Number(buckets.overdue.d31_60),
        d60_plus: Number(buckets.overdue.d60_plus),
        asOfDate: asOfRange.from,
        timeZone: b.timeZone,
        branch: this.branchInfo(b),
        rows,
      };
    });
  }

  // ── §2.3 Financial summary (was: month-end close) ─────────────────────────

  /**
   * "Ringkasan keuangan" over any range. Revenue, invoiced, received and the
   * deposit movements are FLOWS inside the range; AR, deposits held and tax
   * payable are BALANCES as of the end of the range (all ledger movement up
   * to that instant). The two shapes are not interchangeable, so each is
   * computed the way its account behaves.
   *
   * `accounts` is the trial-balance view the CSV exports: per ledger account,
   * the balance before the range, the debits and credits inside it and the
   * balance at its end.
   */
  async financialSummary(tenantId: string, from?: string, to?: string): Promise<FinancialSummaryResponse> {
    const b = await this.branch(tenantId);
    const range = this.rangeFor(b, from, to);
    const inRange = { gte: range.start, lt: range.endExclusive };

    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const [before, during, depositCash, invoices, payments] = await Promise.all([
        tx.ledgerEntry.groupBy({ by: ["account", "entryType"], where: { createdAt: { lt: range.start } }, _sum: { amount: true } }),
        tx.ledgerEntry.groupBy({ by: ["account", "entryType"], where: { createdAt: inRange }, _sum: { amount: true } }),
        // Deposit money that actually moved: CASH in when a deposit is collected, CASH out when it is refunded.
        tx.ledgerEntry.groupBy({ by: ["entryType"], where: { createdAt: inRange, account: "CASH", referenceType: "DEPOSIT" }, _sum: { amount: true } }),
        tx.invoice.findMany({
          where: { issueDate: inRange, status: { notIn: [...NOT_SALES_STATUSES] } },
          select: { totalAmount: true, lines: { where: { lineType: "DEPOSIT" }, select: { amount: true } } },
        }),
        tx.payment.aggregate({ where: { status: { in: [...RECEIVED_STATUSES] }, paidAt: inRange }, _sum: { amount: true }, _count: true }),
      ]);

      const side = (rows: typeof before, account: string, entryType: "DEBIT" | "CREDIT"): D =>
        money(rows.find((r) => r.account === account && r.entryType === entryType)?._sum.amount?.toString() ?? 0);
      const balance = (debit: D, credit: D, normal: "DEBIT" | "CREDIT"): D => (normal === "DEBIT" ? debit.minus(credit) : credit.minus(debit));

      const names = new Set<string>([...before.map((r) => r.account as string), ...during.map((r) => r.account as string)]);
      const accounts: LedgerAccountSummary[] = [...names]
        .sort((x, y) => (ACCOUNT_ORDER.indexOf(x) + 1 || 99) - (ACCOUNT_ORDER.indexOf(y) + 1 || 99) || x.localeCompare(y))
        .map((account) => {
          const normalSide = NORMAL_SIDE[account] ?? "DEBIT";
          const opening = balance(side(before, account, "DEBIT"), side(before, account, "CREDIT"), normalSide);
          const debit = side(during, account, "DEBIT");
          const credit = side(during, account, "CREDIT");
          return { account, normalSide, opening: str(opening), debit: str(debit), credit: str(credit), closing: str(opening.plus(balance(debit, credit, normalSide))) };
        });
      const closing = (account: string): string => accounts.find((a) => a.account === account)?.closing ?? "0";

      const invoicedAmount = invoices.reduce<D>((acc, i) => acc.plus(money(i.totalAmount.toString())).minus(sum(i.lines.map((l) => l.amount))), money(0));
      const cash = (entryType: "DEBIT" | "CREDIT"): D => money(depositCash.find((r) => r.entryType === entryType)?._sum.amount?.toString() ?? 0);

      return {
        range: { from: range.from, to: range.to, timeZone: range.timeZone },
        branch: this.branchInfo(b),
        revenueRecognized: str(side(during, "REVENUE", "CREDIT").minus(side(during, "REVENUE", "DEBIT"))),
        invoiced: { count: invoices.length, amount: str(invoicedAmount) },
        received: { count: payments._count, amount: str(money(payments._sum.amount?.toString() ?? 0)) },
        depositsReceived: str(cash("DEBIT")),
        refunds: str(cash("CREDIT")),
        accountsReceivable: closing("ACCOUNTS_RECEIVABLE"),
        depositsHeld: closing("DEPOSIT_LIABILITY"),
        taxPayable: b.isPkp ? closing("TAX_PAYABLE") : null,
        accounts,
      };
    });
  }

  /**
   * `GET /reports/month-end?year&month` — kept for anything that still calls
   * it. A thin alias: the calendar month in the branch's timezone, through
   * the range report above.
   */
  async monthEndClose(tenantId: string, year?: number, month?: number): Promise<MonthEndCloseResponse> {
    const b = await this.branch(tenantId);
    const today = zonedDateString(new Date(), b.timeZone);
    const y = year ?? Number(today.slice(0, 4));
    const m = month ?? Number(today.slice(5, 7));
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12 || y < 2000 || y > 2100) {
      throw new BadRequestException("month-end close requires a valid year and month (1-12).");
    }
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const ym = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
    const s = await this.financialSummary(tenantId, `${ym}-01`, `${ym}-${String(lastDay).padStart(2, "0")}`);
    return {
      period: { year: y, month: m },
      revenueRecognized: s.revenueRecognized,
      depositsHeld: s.depositsHeld,
      accountsReceivable: s.accountsReceivable,
      refunds: s.refunds,
      taxPayable: s.taxPayable ?? "0",
    };
  }

  // ── §2.2 Sales report ─────────────────────────────────────────────────────

  /**
   * "Penjualan" — how much was sold and how much came in, live, over any range.
   *
   *   Sales (penjualan)  = invoices issued in the range, deposits excluded.
   *   Received (penerimaan) = payments that reached SUCCEEDED in the range,
   *                        dated by paidAt — the figure that matches the bank
   *                        statement, so it INCLUDES a deposit paid with the rent.
   *   Deposits           = shown on their own lines and never counted as sales.
   *   Net cash in        = received − deposits refunded.
   */
  async salesReport(
    tenantId: string,
    opts: { from?: string; to?: string; groupBy?: SalesGroupBy; status?: SalesTransactionStatus; method?: string },
  ): Promise<SalesReportResponse> {
    const b = await this.branch(tenantId);
    const range = this.rangeFor(b, opts.from, opts.to);
    const groupBy: SalesGroupBy = opts.groupBy ?? "day";
    const status: SalesTransactionStatus = opts.status ?? "SUCCEEDED";
    if (opts.method && !(PAYMENT_METHODS as readonly string[]).includes(opts.method)) {
      throw new BadRequestException(`method must be one of ${PAYMENT_METHODS.join(", ")}.`);
    }
    const inRange = { gte: range.start, lt: range.endExclusive };

    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const [invoices, payments, depositCash, creditNotes, started, endedEvents] = await Promise.all([
        tx.invoice.findMany({
          where: { issueDate: inRange, status: { notIn: [...NOT_SALES_STATUSES] } },
          select: { issueDate: true, totalAmount: true, lines: { where: { lineType: "DEPOSIT" }, select: { amount: true } } },
        }),
        // Dated by paidAt; a payment that has not been paid (pending/failed) by when it was recorded.
        tx.payment.findMany({
          where: { OR: [{ paidAt: inRange }, { paidAt: null, createdAt: inRange }] },
          include: {
            invoice: {
              select: {
                id: true,
                invoiceNumber: true,
                customer: { select: { id: true, fullName: true, companyName: true, phone: true, customerNumber: true } },
                booking: { select: { asset: { select: { code: true } }, contracts: { orderBy: { createdAt: "desc" }, take: 1, select: { contractNumber: true } } } },
                rentalOrder: { select: { asset: { select: { code: true } }, contracts: { orderBy: { createdAt: "desc" }, take: 1, select: { contractNumber: true } } } },
              },
            },
          },
        }),
        tx.ledgerEntry.findMany({ where: { createdAt: inRange, account: "CASH", referenceType: "DEPOSIT" }, select: { entryType: true, amount: true, createdAt: true } }),
        tx.creditNote.findMany({ where: { createdAt: inRange }, select: { amount: true } }),
        tx.booking.count({ where: { startDate: inRange, status: { notIn: [...NOT_STARTED_STATUSES] } } }),
        tx.bookingEvent.findMany({ where: { createdAt: inRange, toStatus: { in: [...ENDED_STATUSES] } }, select: { bookingId: true }, distinct: ["bookingId"] }),
      ]);

      const staffIds = [...new Set(payments.flatMap((p) => [p.recordedByUserId, p.verifiedByUserId]).filter((id): id is string => Boolean(id)))];
      const staff = staffIds.length ? await tx.user.findMany({ where: { id: { in: staffIds } }, select: { id: true, displayName: true, email: true } }) : [];
      const staffName = (id: string | null) => {
        if (!id) return null;
        const u = staff.find((s) => s.id === id);
        return u ? (u.displayName ?? u.email) : null;
      };

      const isReceived = (p: (typeof payments)[number]) => (RECEIVED_STATUSES as readonly string[]).includes(p.status) && p.paidAt !== null;
      const received = payments.filter(isReceived);
      const depositsIn = depositCash.filter((e) => e.entryType === "DEBIT");
      const depositsOut = depositCash.filter((e) => e.entryType === "CREDIT");
      const salesAmount = (i: (typeof invoices)[number]): D => money(i.totalAmount.toString()).minus(sum(i.lines.map((l) => l.amount)));

      // Every period of the range gets a row, including the ones where nothing happened.
      const keyOfDay = (ymd: string) => (groupBy === "day" ? ymd : groupBy === "month" ? ymd.slice(0, 7) : rangeBucket(zonedStartOfDay(ymd, b.timeZone), "week", b.timeZone));
      const totals = new Map<string, { invoiced: D; received: D; depositsReceived: D; depositsRefunded: D }>();
      for (const day of daysInRange(range)) {
        const k = keyOfDay(day);
        if (!totals.has(k)) totals.set(k, { invoiced: money(0), received: money(0), depositsReceived: money(0), depositsRefunded: money(0) });
      }
      const slot = (at: Date) => totals.get(rangeBucket(at, groupBy, b.timeZone));
      for (const i of invoices) {
        const t = slot(i.issueDate);
        if (t) t.invoiced = t.invoiced.plus(salesAmount(i));
      }
      for (const p of received) {
        const t = slot(p.paidAt!);
        if (t) t.received = t.received.plus(money(p.amount.toString()));
      }
      for (const e of depositsIn) {
        const t = slot(e.createdAt);
        if (t) t.depositsReceived = t.depositsReceived.plus(money(e.amount.toString()));
      }
      for (const e of depositsOut) {
        const t = slot(e.createdAt);
        if (t) t.depositsRefunded = t.depositsRefunded.plus(money(e.amount.toString()));
      }
      const periods: SalesPeriodRow[] = [...totals.entries()].map(([period, t]) => ({
        period,
        invoiced: str(t.invoiced),
        received: str(t.received),
        depositsReceived: str(t.depositsReceived),
        depositsRefunded: str(t.depositsRefunded),
        netCashIn: str(t.received.minus(t.depositsRefunded)),
      }));

      const byMethod = PAYMENT_METHODS.map((method) => {
        const of = received.filter((p) => p.method === method);
        return { method, count: of.length, amount: str(sum(of.map((p) => p.amount))) };
      }).filter((m) => m.count > 0);

      const wanted = (p: (typeof payments)[number]) => {
        if (opts.method && p.method !== opts.method) return false;
        if (status === "ALL") return true;
        if (status === "SUCCEEDED") return isReceived(p);
        return p.status === status;
      };
      const transactions: SalesTransactionRow[] = payments
        .filter(wanted)
        .map((p) => {
          const at = p.paidAt ?? p.createdAt;
          const owner = p.invoice.rentalOrder ?? p.invoice.booking;
          const c = p.invoice.customer;
          return {
            paymentId: p.id,
            invoiceId: p.invoice.id,
            at: at.toISOString(),
            atLocal: zonedDateTimeString(at, b.timeZone),
            customerId: c.id,
            customer: c.fullName ?? c.companyName ?? c.phone,
            customerNumber: c.customerNumber,
            contractNumber: owner?.contracts[0]?.contractNumber ?? null,
            invoiceNumber: p.invoice.invoiceNumber,
            unit: owner?.asset?.code ?? null,
            method: p.method,
            provider: p.provider,
            reference: p.providerRef,
            amount: roundMoney(money(p.amount.toString())).toString(),
            status: p.status,
            recordedBy: staffName(p.recordedByUserId),
            verifiedBy: staffName(p.verifiedByUserId),
          };
        })
        .sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.invoiceNumber.localeCompare(y.invoiceNumber)));

      const receivedTotal = sum(received.map((p) => p.amount));
      const refundedTotal = sum(depositsOut.map((e) => e.amount));
      return {
        range: { from: range.from, to: range.to, timeZone: range.timeZone },
        branch: this.branchInfo(b),
        groupBy,
        summary: {
          invoicesIssued: { count: invoices.length, amount: str(invoices.reduce<D>((acc, i) => acc.plus(salesAmount(i)), money(0))) },
          paymentsReceived: { count: received.length, amount: str(receivedTotal), byMethod },
          depositsReceived: { count: depositsIn.length, amount: str(sum(depositsIn.map((e) => e.amount))) },
          depositsRefunded: { count: depositsOut.length, amount: str(refundedTotal) },
          rentalsStarted: started,
          rentalsEnded: endedEvents.length,
          creditNotes: { count: creditNotes.length, amount: str(sum(creditNotes.map((c) => c.amount))) },
          netCashIn: str(receivedTotal.minus(refundedTotal)),
        },
        periods,
        filter: { status, method: opts.method ?? null },
        transactions,
      };
    });
  }

  // ── §2.4 CSV exports ──────────────────────────────────────────────────────
  //
  // Conventions (csv.util.ts): whole-rupiah amounts, YYYY-MM-DD dates and
  // YYYY-MM-DD HH:mm timestamps in the branch's timezone. §2.6: a branch that
  // is not PKP gets no tax column at all.

  async exportInvoices(b: ReportBranch, range: ReportRange | null): Promise<CsvExport> {
    const tz = b.timeZone;
    const rows = await this.prisma.runInTenantContext(b.id, async (tx) => {
      const invoices = await tx.invoice.findMany({
        where: { issueDate: this.within(range) },
        include: {
          customer: { select: { fullName: true, companyName: true, phone: true, customerNumber: true } },
          lines: { where: { lineType: "DEPOSIT" }, select: { amount: true } },
          booking: { select: { asset: { select: { code: true } }, contracts: { orderBy: { createdAt: "desc" }, take: 1, select: { contractNumber: true } } } },
          rentalOrder: { select: { asset: { select: { code: true } }, contracts: { orderBy: { createdAt: "desc" }, take: 1, select: { contractNumber: true } } } },
        },
        orderBy: [{ issueDate: "asc" }, { invoiceNumber: "asc" }],
      });
      return invoices.map((inv): CsvRow => {
        const owner = inv.rentalOrder ?? inv.booking;
        return {
          invoiceNumber: inv.invoiceNumber,
          status: inv.status,
          customerNumber: inv.customer.customerNumber,
          customer: inv.customer.fullName ?? inv.customer.companyName ?? inv.customer.phone,
          contractNumber: owner?.contracts[0]?.contractNumber ?? null,
          unit: owner?.asset?.code ?? null,
          issueDate: csvDate(inv.issueDate, tz),
          dueDate: csvDate(inv.dueDate, tz),
          periodStart: csvDate(inv.periodStart, tz),
          periodEnd: csvDate(inv.periodEnd, tz),
          subtotal: csvAmount(inv.subtotal),
          taxAmount: csvAmount(inv.taxAmount),
          totalAmount: csvAmount(inv.totalAmount),
          depositAmount: csvAmount(sum(inv.lines.map((l) => l.amount))),
          paidAt: csvDateTime(inv.paidAt, tz),
          voidedAt: csvDateTime(inv.voidedAt, tz),
          voidReason: inv.voidReason,
        };
      });
    });
    const columns = ["invoiceNumber", "status", "customerNumber", "customer", "contractNumber", "unit", "issueDate", "dueDate", "periodStart", "periodEnd", "subtotal", "taxAmount", "totalAmount", "depositAmount", "paidAt", "voidedAt", "voidReason"];
    return { rows, columns: b.isPkp ? columns : columns.filter((c) => c !== "taxAmount") };
  }

  /** Dated by paidAt (go-live 2 §2.4); a payment not yet paid is dated by when it was recorded. */
  async exportPayments(b: ReportBranch, range: ReportRange | null): Promise<CsvExport> {
    const report = await this.salesTransactionsFor(b, range, "ALL");
    return {
      rows: report.map((t) => this.transactionCsvRow(t)),
      columns: ["paidAt", "invoiceNumber", "customerNumber", "customer", "contractNumber", "unit", "method", "provider", "reference", "amount", "status", "recordedBy", "verifiedBy"],
    };
  }

  private async salesTransactionsFor(b: ReportBranch, range: ReportRange | null, status: SalesTransactionStatus, method?: string): Promise<SalesTransactionRow[]> {
    // "Everything": from the first payment ever recorded to tomorrow, through the same code path.
    let from = range?.from;
    if (!from) {
      const first = await this.prisma.runInTenantContext(b.id, (tx) => tx.payment.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true, paidAt: true } }));
      if (!first) return [];
      const earliest = first.paidAt && first.paidAt < first.createdAt ? first.paidAt : first.createdAt;
      from = zonedDateString(new Date(earliest.getTime() - 86_400_000), b.timeZone);
    }
    const to = range?.to ?? zonedDateString(new Date(Date.now() + 86_400_000), b.timeZone);
    // resolveReportRange caps a range at five years; "everything" is asked for in slices.
    const out: SalesTransactionRow[] = [];
    let cursor = from;
    while (cursor <= to) {
      const end = [addYears(cursor, 4), to].sort()[0]!;
      const slice = await this.salesReport(b.id, { from: cursor, to: end, status, method });
      out.push(...slice.transactions);
      cursor = nextDay(end);
    }
    return out;
  }

  private transactionCsvRow(t: SalesTransactionRow): CsvRow {
    return {
      paidAt: t.atLocal,
      invoiceNumber: t.invoiceNumber,
      customerNumber: t.customerNumber,
      customer: t.customer,
      contractNumber: t.contractNumber,
      unit: t.unit,
      method: t.method,
      provider: t.provider,
      reference: t.reference,
      amount: csvAmount(t.amount),
      status: t.status,
      recordedBy: t.recordedBy,
      verifiedBy: t.verifiedBy,
    };
  }

  /**
   * BUILD-SPEC #37 — bulk export of contracts (with their order/booking + customer)
   * for the finance/legal bundle. This is the DATA layer; zipping the actual
   * signed PDFs is deferred until real signed documents exist.
   */
  async exportContracts(b: ReportBranch, range: ReportRange | null): Promise<CsvExport> {
    const tz = b.timeZone;
    const rows = await this.prisma.runInTenantContext(b.id, async (tx) => {
      const contracts = await tx.contract.findMany({
        where: { createdAt: this.within(range) },
        include: {
          booking: { select: { id: true, startDate: true, endDate: true, status: true, asset: { select: { code: true } }, customer: { select: { fullName: true, companyName: true, phone: true, customerNumber: true } } } },
          rentalOrder: { select: { id: true, periodStart: true, periodEnd: true, status: true, asset: { select: { code: true } }, customer: { select: { fullName: true, companyName: true, phone: true, customerNumber: true } } } },
        },
        orderBy: { createdAt: "asc" },
      });
      return contracts.map((c): CsvRow => {
        const cust = c.rentalOrder?.customer ?? c.booking?.customer;
        return {
          contractNumber: c.contractNumber,
          customerNumber: cust?.customerNumber ?? null,
          customer: cust?.fullName ?? cust?.companyName ?? cust?.phone ?? null,
          unit: c.rentalOrder?.asset?.code ?? c.booking?.asset?.code ?? null,
          rentalStatus: c.rentalOrder?.status ?? c.booking?.status ?? null,
          periodStart: csvDate(c.rentalOrder?.periodStart ?? c.booking?.startDate, tz),
          periodEnd: csvDate(c.rentalOrder?.periodEnd ?? c.booking?.endDate, tz),
          createdAt: csvDateTime(c.createdAt, tz),
          esignProvider: c.esignProvider,
          esignStatus: c.esignStatus,
          signedAt: csvDateTime(c.signedAt, tz),
          signedByName: c.signedByName,
          confirmedAt: csvDateTime(c.confirmedAt, tz),
          contractId: c.id,
          bookingId: c.bookingId,
          rentalOrderId: c.rentalOrderId,
        };
      });
    });
    return {
      rows,
      columns: ["contractNumber", "customerNumber", "customer", "unit", "rentalStatus", "periodStart", "periodEnd", "createdAt", "esignProvider", "esignStatus", "signedAt", "signedByName", "confirmedAt", "contractId", "bookingId", "rentalOrderId"],
    };
  }

  async exportLedger(b: ReportBranch, range: ReportRange | null): Promise<CsvExport> {
    const rows = await this.prisma.runInTenantContext(b.id, async (tx) => {
      const entries = await tx.ledgerEntry.findMany({ where: { createdAt: this.within(range) }, orderBy: { createdAt: "asc" } });
      return entries.map(
        (e): CsvRow => ({
          date: csvDateTime(e.createdAt, b.timeZone),
          account: e.account,
          entryType: e.entryType,
          amount: csvAmount(e.amount),
          currency: e.currency,
          referenceType: e.referenceType,
          referenceId: e.referenceId,
          description: e.description,
        }),
      );
    });
    return { rows, columns: ["date", "account", "entryType", "amount", "currency", "referenceType", "referenceId", "description"] };
  }

  /** One row per tile, then one row per ledger account (opening, debit, credit, closing). */
  financialSummaryCsv(s: FinancialSummaryResponse): CsvExport {
    const tile = (item: string, basis: string, amount: string | null, count?: number): CsvRow => ({ section: "summary", item, basis, count: count ?? null, amount: csvAmount(amount) });
    const rows: CsvRow[] = [
      tile("revenueRecognized", "in range", s.revenueRecognized),
      tile("invoiced", "in range", s.invoiced.amount, s.invoiced.count),
      tile("received", "in range", s.received.amount, s.received.count),
      tile("depositsReceived", "in range", s.depositsReceived),
      tile("depositsRefunded", "in range", s.refunds),
      tile("accountsReceivable", "end of range", s.accountsReceivable),
      tile("depositsHeld", "end of range", s.depositsHeld),
      ...(s.taxPayable !== null ? [tile("taxPayable", "end of range", s.taxPayable)] : []),
      ...s.accounts
        .filter((a) => s.branch.isPkp || a.account !== "TAX_PAYABLE")
        .map(
          (a): CsvRow => ({
            section: "ledger",
            item: a.account,
            basis: `${a.normalSide.toLowerCase()}-normal`,
            opening: csvAmount(a.opening),
            debit: csvAmount(a.debit),
            credit: csvAmount(a.credit),
            closing: csvAmount(a.closing),
          }),
        ),
    ];
    return { rows, columns: ["section", "item", "basis", "count", "amount", "opening", "debit", "credit", "closing"] };
  }

  salesSummaryCsv(r: SalesReportResponse): CsvExport {
    const s = r.summary;
    const row = (item: string, count: number | null, amount: string | null): CsvRow => ({ item, count, amount: csvAmount(amount) });
    return {
      rows: [
        row("invoicesIssued", s.invoicesIssued.count, s.invoicesIssued.amount),
        row("paymentsReceived", s.paymentsReceived.count, s.paymentsReceived.amount),
        ...s.paymentsReceived.byMethod.map((m) => row(`paymentsReceived:${m.method}`, m.count, m.amount)),
        row("depositsReceived", s.depositsReceived.count, s.depositsReceived.amount),
        row("depositsRefunded", s.depositsRefunded.count, s.depositsRefunded.amount),
        row("netCashIn", null, s.netCashIn),
        row("creditNotes", s.creditNotes.count, s.creditNotes.amount),
        row("rentalsStarted", s.rentalsStarted, null),
        row("rentalsEnded", s.rentalsEnded, null),
      ],
      columns: ["item", "count", "amount"],
    };
  }

  /** `sales-daily.csv` — one row per period of the chosen grouping (a day unless `groupBy` says otherwise). */
  salesPeriodsCsv(r: SalesReportResponse): CsvExport {
    return {
      rows: r.periods.map((p) => ({
        period: p.period,
        invoiced: csvAmount(p.invoiced),
        received: csvAmount(p.received),
        depositsReceived: csvAmount(p.depositsReceived),
        depositsRefunded: csvAmount(p.depositsRefunded),
        netCashIn: csvAmount(p.netCashIn),
      })),
      columns: ["period", "invoiced", "received", "depositsReceived", "depositsRefunded", "netCashIn"],
    };
  }

  salesTransactionsCsv(r: SalesReportResponse): CsvExport {
    return {
      rows: r.transactions.map((t) => this.transactionCsvRow(t)),
      columns: ["paidAt", "invoiceNumber", "customerNumber", "customer", "contractNumber", "unit", "method", "provider", "reference", "amount", "status", "recordedBy", "verifiedBy"],
    };
  }

  /** `ar-aging.csv` — the invoice-level rows, each with the bucket it was counted in. */
  arAgingCsv(aging: ArAgingResponse, timeZone: string): CsvExport {
    return {
      rows: (aging.rows ?? []).map((r) => ({
        bucket: r.bucket,
        customerNumber: r.customerNumber,
        customer: r.customer,
        contractNumber: r.contractNumber,
        invoiceNumber: r.invoiceNumber,
        unit: r.unit,
        dueDate: r.dueDate,
        daysOverdue: r.daysOverdue,
        amountOutstanding: csvAmount(r.amountOutstanding),
        status: r.status,
        lastReminderSent: csvDateTime(r.lastReminderAt, timeZone),
        lastReminderTemplate: r.lastReminderTemplate,
      })),
      columns: ["bucket", "customerNumber", "customer", "contractNumber", "invoiceNumber", "unit", "dueDate", "daysOverdue", "amountOutstanding", "status", "lastReminderSent", "lastReminderTemplate"],
    };
  }

  /** `clients.csv` — the client list exactly as the Clients page computes it (health, outstanding, next due). */
  async exportClients(b: ReportBranch): Promise<CsvExport> {
    const list = await this.crm.listClients(b.id, { page: 1, pageSize: 1_000_000 });
    const tz = b.timeZone;
    return {
      rows: list.items.map((c) => ({
        customerNumber: c.customerNumber ?? null,
        customer: c.fullName,
        phone: c.phone,
        email: c.email,
        kycStatus: c.kycStatus,
        health: c.health,
        units: c.units.map((u) => u.code ?? "(belum ditentukan)").join(" | "),
        unitTypes: [...new Set(c.units.map((u) => u.assetTypeName))].join(" | "),
        moveInDate: csvDate(c.moveInDate, tz),
        outstandingAmount: csvAmount(c.outstandingAmount),
        overdueInvoices: c.overdueCount,
        nextDueDate: csvDate(c.nextDueDate, tz),
        nextDueAmount: csvAmount(c.nextDueAmount),
        customerSince: csvDate(c.createdAt, tz),
      })),
      columns: ["customerNumber", "customer", "phone", "email", "kycStatus", "health", "units", "unitTypes", "moveInDate", "outstandingAmount", "overdueInvoices", "nextDueDate", "nextDueAmount", "customerSince"],
    };
  }
}

function nextDay(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function addYears(ymd: string, years: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCFullYear(d.getUTCFullYear() + years);
  return d.toISOString().slice(0, 10);
}
