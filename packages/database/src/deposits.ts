import type { DepositEventType, DepositSource, Prisma } from "../generated/client/index.js";

/**
 * PRD go-live 2 §3.1 — the deposit's dates and its movement log.
 *
 * Every code path that moves a deposit goes through here, in the SAME
 * transaction as the ledger entries of that movement, so the two can never
 * tell different stories:
 *
 *   held = Σ HELD + Σ ADJUSTED − Σ APPLIED − Σ REFUNDED
 *        = the DEPOSIT_LIABILITY balance of the ledger.
 *
 * The deposit report (apps/api DepositsService.report) recomputes both sides
 * for the end of any date range and warns when they disagree.
 */

/** T&C IV.3 — the deposit is returned within 30 days of the end of the lease. */
export const DEPOSIT_REFUND_DAYS = 30;

const DAY_MS = 86_400_000;

interface LeaseDates {
  endDate: Date | null;
  noticeEffectiveDate: Date | null;
}

/**
 * When the lease ends, as far as is known today: the notice date when notice
 * ends it before its term (same rule as storage-availability), else the term
 * end. An open-ended lease with no notice has no end yet.
 */
export function depositLeaseEnd(booking: LeaseDates): Date | null {
  const { endDate, noticeEffectiveDate } = booking;
  if (noticeEffectiveDate && (!endDate || noticeEffectiveDate < endDate)) return noticeEffectiveDate;
  return endDate ?? null;
}

/** Lease end + 30 days, or null while the lease has no end date. */
export function depositRefundDueAt(booking: LeaseDates): Date | null {
  const end = depositLeaseEnd(booking);
  return end ? new Date(end.getTime() + DEPOSIT_REFUND_DAYS * DAY_MS) : null;
}

export async function recordDepositEvent(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    depositId: string;
    type: DepositEventType;
    /** Positive, except ADJUSTED which is signed. */
    amount: string | number;
    occurredAt?: Date;
    actorUserId?: string | null;
    note?: string | null;
  },
) {
  return tx.depositEvent.create({
    data: {
      tenantId: params.tenantId,
      depositId: params.depositId,
      type: params.type,
      amount: typeof params.amount === "number" ? params.amount.toFixed(2) : params.amount,
      ...(params.occurredAt ? { occurredAt: params.occurredAt } : {}),
      actorUserId: params.actorUserId ?? null,
      note: params.note ?? null,
    },
  });
}

/**
 * Create a deposit that is HELD from the start: the row with its report dates
 * (customer, received date, refund due) and its HELD event. The caller posts
 * the ledger entries (CASH for money received here, OPENING_BALANCE for a
 * legacy import) in the same transaction.
 */
export async function createHeldDeposit(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    bookingId: string;
    amount: string;
    source?: DepositSource;
    receivedAt?: Date;
    note?: string;
  },
) {
  const booking = await tx.booking.findUniqueOrThrow({
    where: { id: params.bookingId },
    select: { customerId: true, endDate: true, noticeEffectiveDate: true },
  });
  const receivedAt = params.receivedAt ?? new Date();
  const deposit = await tx.deposit.create({
    data: {
      tenantId: params.tenantId,
      bookingId: params.bookingId,
      amount: params.amount,
      status: "HELD",
      customerId: booking.customerId,
      source: params.source ?? "RENTOS",
      receivedAt,
      refundDueAt: depositRefundDueAt(booking),
    },
  });
  await recordDepositEvent(tx, {
    tenantId: params.tenantId,
    depositId: deposit.id,
    type: "HELD",
    amount: params.amount,
    occurredAt: receivedAt,
    note: params.note ?? (params.source === "LEGACY" ? "Opening balance from the legacy system" : "Deposit collected"),
  });
  return deposit;
}

/**
 * Re-derive `refundDueAt` (and the denormalised customer) of a booking's
 * deposits from the booking as it is now. Call it in the transaction of
 * anything that sets or moves a lease's end: notice given, a term changed, a
 * start date moved, an extension, a customer merge.
 */
export async function syncDepositRefundDue(tx: Prisma.TransactionClient, bookingId: string): Promise<void> {
  const booking = await tx.booking.findUnique({
    where: { id: bookingId },
    select: { customerId: true, endDate: true, noticeEffectiveDate: true },
  });
  if (!booking) return;
  await tx.deposit.updateMany({
    where: { bookingId },
    data: { refundDueAt: depositRefundDueAt(booking), customerId: booking.customerId },
  });
}

/** What a deposit still holds: nothing once refunded, else amount − applied. */
export function depositRemaining(deposit: { amount: { toString(): string }; appliedAmount: { toString(): string }; status: string }): number {
  if (deposit.status === "REFUNDED") return 0;
  return Math.max(0, Math.round((Number(deposit.amount.toString()) - Number(deposit.appliedAmount.toString())) * 100) / 100);
}
