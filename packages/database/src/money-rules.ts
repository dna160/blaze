import {
  arrearsStatus,
  calendarDaysBetween,
  dailyPenalty,
  LATE_FEE_LINE,
  money,
  OVERSTAY_FEE_LINE,
  OVERTIME_LINE,
  overtimeCharge,
  penaltyBase,
  penaltyDaysToCharge,
  type MoneyRulesConfig,
} from "@rentos/domain";

import type { Prisma } from "../generated/client/index.js";
import { createAdHocInvoice } from "./invoicing.js";
import { legacyAutomationHold } from "./legacy-hold.js";

/**
 * PRD go-live 2 §10.3 — the T&C money rules, applied. Every function here is
 * a no-op unless its rule is enabled in the branch's `featureFlags.moneyRules`
 * (resolveMoneyRules in packages/domain), and every one is idempotent: the
 * daily job can run twice, or miss a day and catch up, without charging
 * anything twice.
 *
 * Charges are added as invoice lines (lineType LATE_FEE / OVERSTAY_FEE /
 * OVERTIME — InvoiceLine.lineType is free text). On an ISSUED invoice the
 * line raises subtotal and total and posts AR (debit) / REVENUE (credit)
 * under reference INVOICE, so voiding the invoice later reverses it with
 * everything else. On a SCHEDULED invoice nothing is posted until issue,
 * which recognises every non-deposit line. The charges carry no PPN here:
 * whether penalties are taxable is a question for City Storage's tax adviser
 * (part 2 §12 Q4); until answered they are untaxed.
 *
 * All functions run inside a tenant context.
 */

const UNPAID = ["ISSUED", "OVERDUE"] as const;
/** A lease that is still running (the late fee is for EXTENSIONS, T&C V.3 — not the first proforma). */
const RUNNING = ["ACTIVE", "RENEWING", "SUSPENDED", "NOTICE_GIVEN"] as const;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Add a charge line to an existing invoice and keep totals and the ledger in step. */
export async function addInvoiceCharge(
  tx: Prisma.TransactionClient,
  tenantId: string,
  invoiceId: string,
  line: { description: string; amount: string; lineType: string },
) {
  const inv = await tx.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  const amount = money(line.amount);
  if (amount.lte(0)) return inv;
  await tx.invoiceLine.create({
    data: { tenantId, invoiceId, description: line.description, quantity: "1", unitPrice: amount.toString(), amount: amount.toString(), lineType: line.lineType },
  });
  const updated = await tx.invoice.update({
    where: { id: invoiceId },
    data: {
      subtotal: money(inv.subtotal.toString()).plus(amount).toString(),
      totalAmount: money(inv.totalAmount.toString()).plus(amount).toString(),
      documentUrl: null, // the cached PDF no longer matches; re-rendered on next open
    },
  });
  if (inv.status !== "SCHEDULED") {
    const description = `${line.description} — invoice ${inv.invoiceNumber}`;
    await tx.ledgerEntry.create({ data: { tenantId, account: "ACCOUNTS_RECEIVABLE", entryType: "DEBIT", amount: amount.toString(), currency: "IDR", referenceType: "INVOICE", referenceId: invoiceId, description } });
    await tx.ledgerEntry.create({ data: { tenantId, account: "REVENUE", entryType: "CREDIT", amount: amount.toString(), currency: "IDR", referenceType: "INVOICE", referenceId: invoiceId, description } });
  }
  return updated;
}

/**
 * Late fee (T&C V.3): for each unpaid invoice of a RUNNING lease that is past
 * its due date, one LATE_FEE line per day late — `ratePerDay` of the bill
 * (rent and other charges, without deposit, tax or earlier penalties) — up
 * to `maxDays`. Day 15 onwards is the existing dunning ladder's business
 * (suspension at 14 days overdue). Imported rentals under the legacy hold are
 * skipped like every other automation.
 */
export async function accrueLateFees(
  tx: Prisma.TransactionClient,
  tenant: { id: string; featureFlags: unknown },
  rules: MoneyRulesConfig,
  today: string,
): Promise<{ invoices: number; lines: number; amount: number }> {
  const out = { invoices: 0, lines: 0, amount: 0 };
  if (!rules.lateFee.enabled) return out;
  const held = legacyAutomationHold(tenant.featureFlags);
  const invoices = await tx.invoice.findMany({
    where: {
      status: { in: [...UNPAID] },
      dueDate: { lt: new Date(`${today}T00:00:00.000Z`) },
      booking: { status: { in: [...RUNNING] }, ...(held ? { legacyBookingNumber: null } : {}) },
      NOT: { scheduleIndex: 0 }, // the proforma is not an extension; an unpaid one lapses the booking instead
    },
    include: { lines: true },
  });
  for (const inv of invoices) {
    const daysLate = calendarDaysBetween(ymd(inv.dueDate), today);
    const charged = inv.lines.filter((l) => l.lineType === LATE_FEE_LINE).length;
    const days = penaltyDaysToCharge(daysLate, charged, rules.lateFee.maxDays);
    if (!days.length) continue;
    const base = penaltyBase(inv.lines.map((l) => ({ lineType: l.lineType, amount: l.amount.toString() })));
    const fee = dailyPenalty(base, rules.lateFee.ratePerDay);
    if (fee.lte(0)) continue;
    for (const day of days) {
      await addInvoiceCharge(tx, tenant.id, inv.id, {
        description: `Denda keterlambatan hari ke-${day} (${(rules.lateFee.ratePerDay * 100).toLocaleString("id-ID")}%/hari) / Late fee day ${day}`,
        amount: fee.toString(),
        lineType: LATE_FEE_LINE,
      });
      out.lines += 1;
      out.amount += fee.toNumber();
    }
    out.invoices += 1;
  }
  return out;
}

/**
 * Overstay (T&C VI.4): a lease whose end date (its `endDate`, or the notice's
 * effective date) has passed while the booking is still running — staff have
 * not moved the customer out — accrues `ratePerDay` of the monthly rent per
 * day, up to `maxDays`, on ONE overstay invoice per booking (created on the
 * first day). Fixed-term leases that the term-lifecycle job moves out on
 * their end date never overstay; this catches the rest.
 */
export async function accrueOverstay(
  tx: Prisma.TransactionClient,
  tenant: { id: string; slug: string; featureFlags: unknown },
  rules: MoneyRulesConfig,
  today: string,
): Promise<{ bookings: number; lines: number; amount: number }> {
  const out = { bookings: 0, lines: 0, amount: 0 };
  if (!rules.overstay.enabled) return out;
  const held = legacyAutomationHold(tenant.featureFlags);
  const todayStart = new Date(`${today}T00:00:00.000Z`);
  const bookings = await tx.booking.findMany({
    where: {
      status: { in: [...RUNNING] },
      OR: [{ endDate: { lt: todayStart } }, { noticeEffectiveDate: { lt: todayStart } }],
      ...(held ? { legacyBookingNumber: null } : {}),
    },
    include: { asset: { select: { code: true } } },
  });
  for (const b of bookings) {
    const ended = [b.endDate, b.noticeEffectiveDate].filter((d): d is Date => !!d && d < todayStart).sort((x, y) => x.getTime() - y.getTime())[0];
    if (!ended) continue;
    const daysOver = calendarDaysBetween(ymd(ended), today);
    const rent = Number((b.priceSnapshot as Record<string, unknown> | null)?.basePrice ?? 0);
    if (!(rent > 0) || daysOver <= 0) continue;
    const fee = dailyPenalty(rent, rules.overstay.ratePerDay);
    // One overstay invoice per booking; count its lines to know which days are charged.
    let inv = await tx.invoice.findFirst({ where: { bookingId: b.id, status: { in: [...UNPAID] }, lines: { some: { lineType: OVERSTAY_FEE_LINE } } }, include: { lines: true } });
    const charged = inv ? inv.lines.filter((l) => l.lineType === OVERSTAY_FEE_LINE).length : 0;
    const allCharged = await tx.invoiceLine.count({ where: { lineType: OVERSTAY_FEE_LINE, invoice: { bookingId: b.id, status: { notIn: ["VOID"] } } } });
    const days = penaltyDaysToCharge(daysOver, Math.max(charged, allCharged), rules.overstay.maxDays);
    if (!days.length || fee.lte(0)) continue;
    const describe = (day: number) => `Denda melewati masa sewa ${b.asset?.code ?? ""} hari ke-${day} / Overstay day ${day}`.replace("  ", " ");
    let rest = days;
    if (!inv) {
      const created = await createAdHocInvoice(
        tx,
        tenant.id,
        tenant.slug,
        { bookingId: b.id, customerId: b.customerId },
        [{ description: describe(days[0]!), amount: fee.toString(), lineType: OVERSTAY_FEE_LINE }],
        { start: ended, end: todayStart },
        todayStart,
      );
      inv = { ...created, lines: created.lines };
      rest = days.slice(1);
      out.lines += 1;
      out.amount += fee.toNumber();
    }
    for (const day of rest) {
      await addInvoiceCharge(tx, tenant.id, inv.id, { description: describe(day), amount: fee.toString(), lineType: OVERSTAY_FEE_LINE });
      out.lines += 1;
      out.amount += fee.toNumber();
    }
    out.bookings += 1;
  }
  return out;
}

/**
 * Overtime access (T&C II.8): hours × the hourly rate, either on the
 * booking's next SCHEDULED invoice or, when it has none (or staff ask), as a
 * one-off invoice due in 7 days. Throws when the rule is off.
 */
export async function chargeOvertime(
  tx: Prisma.TransactionClient,
  tenant: { id: string; slug: string },
  rules: MoneyRulesConfig,
  params: { bookingId: string; hours: number; note?: string | null; target: "NEXT_INVOICE" | "ONE_OFF"; date: string },
) {
  if (!rules.overtime.enabled) throw new MoneyRuleDisabledError("overtime");
  const amount = overtimeCharge(params.hours, rules.overtime.hourlyRate);
  const booking = await tx.booking.findUniqueOrThrow({ where: { id: params.bookingId }, include: { asset: { select: { code: true } } } });
  const description = `Akses di luar jam operasional ${params.date}, ${params.hours.toLocaleString("id-ID")} jam × Rp ${rules.overtime.hourlyRate.toLocaleString("id-ID")} / Overtime access${params.note ? ` — ${params.note}` : ""}`;
  if (params.target === "NEXT_INVOICE") {
    const next = await tx.invoice.findFirst({ where: { bookingId: booking.id, status: "SCHEDULED" }, orderBy: { issueDate: "asc" } });
    if (next) {
      const inv = await addInvoiceCharge(tx, tenant.id, next.id, { description, amount: amount.toString(), lineType: OVERTIME_LINE });
      return { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, amount: amount.toNumber(), target: "NEXT_INVOICE" as const };
    }
  }
  const day = new Date(`${params.date}T00:00:00.000Z`);
  const due = new Date(day.getTime() + 7 * 86_400_000);
  const inv = await createAdHocInvoice(tx, tenant.id, tenant.slug, { bookingId: booking.id, customerId: booking.customerId }, [{ description, amount: amount.toString(), lineType: OVERTIME_LINE }], { start: day, end: day }, due);
  return { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, amount: amount.toNumber(), target: "ONE_OFF" as const };
}

export class MoneyRuleDisabledError extends Error {
  constructor(readonly rule: string) {
    super(`The ${rule} rule is not enabled for this branch (Settings → Branch → T&C money rules).`);
  }
}

/**
 * Deposit refund (T&C IV.3): a deposit still held (HELD / PARTIALLY_APPLIED /
 * REFUND_REQUESTED) whose `refundDueAt` has passed gets a task — stamped once
 * in `refundTaskRaisedAt` and audited — that the deposits page and the staff
 * notification pick up. Returns the deposits raised this run.
 */
export async function raiseDepositRefundTasks(tx: Prisma.TransactionClient, tenantId: string, rules: MoneyRulesConfig, now: Date) {
  if (!rules.depositRefundTask.enabled) return [];
  const due = await tx.deposit.findMany({
    where: { status: { in: ["HELD", "PARTIALLY_APPLIED", "REFUND_REQUESTED"] }, refundDueAt: { lt: now }, refundTaskRaisedAt: null },
    include: { booking: { select: { id: true, asset: { select: { code: true } }, customer: { select: { id: true, fullName: true, customerNumber: true } } } } },
  });
  for (const d of due) {
    await tx.deposit.update({ where: { id: d.id }, data: { refundTaskRaisedAt: now } });
    await tx.auditLog.create({
      data: {
        tenantId,
        action: "DEPOSIT_REFUND_TASK_RAISED",
        entityType: "Deposit",
        entityId: d.id,
        metadata: { refundDueAt: d.refundDueAt?.toISOString(), amount: d.amount.toString(), applied: d.appliedAmount.toString(), unit: d.booking.asset?.code ?? null, customerNumber: d.booking.customer.customerNumber },
      },
    });
  }
  return due.map((d) => ({ id: d.id, unit: d.booking.asset?.code ?? null, customerName: d.booking.customer.fullName, customerNumber: d.booking.customer.customerNumber, amount: d.amount.toString(), refundDueAt: d.refundDueAt }));
}

export interface ArrearsBadge {
  denied: boolean;
  oldestDueDate: string | null;
  daysOverdue: number;
  overdueCount: number;
}

/**
 * "Akses ditolak — tunggakan" (T&C V.5, VI.7) for each customer: null for
 * everyone when the rule is off. Unpaid = ISSUED or OVERDUE.
 */
export async function arrearsByCustomer(tx: Prisma.TransactionClient, rules: MoneyRulesConfig, customerIds: readonly string[], today: string): Promise<Map<string, ArrearsBadge>> {
  const out = new Map<string, ArrearsBadge>();
  if (!rules.arrearsBadge.enabled || customerIds.length === 0) return out;
  const unpaid = await tx.invoice.findMany({ where: { customerId: { in: [...customerIds] }, status: { in: [...UNPAID] } }, select: { customerId: true, dueDate: true } });
  const byCustomer = new Map<string, string[]>();
  for (const i of unpaid) byCustomer.set(i.customerId, [...(byCustomer.get(i.customerId) ?? []), ymd(i.dueDate)]);
  for (const id of customerIds) out.set(id, arrearsStatus(byCustomer.get(id) ?? [], today, rules.arrearsBadge.thresholdDays));
  return out;
}
