import type { BookingStatus, Prisma } from "../generated/client/index.js";

import { recordInvoiceVoidedEntries } from "./ledger.js";

/**
 * Ending a booking that was approved but never started — the money-and-unit
 * part of it, in one place.
 *
 * Two callers need exactly this and must not drift apart:
 *  - a staff cancellation after approval (apps/api BookingService.reject →
 *    REJECTED), and
 *  - the worker's offline-signing deadline (PRD go-live 2 §5.3 → LAPSED), which
 *    is a plain BullMQ process and cannot call a NestJS service.
 *
 * What it does, inside the caller's transaction:
 *  - refuses when money has come in (a SUCCEEDED payment, or one PENDING
 *    verification): that is refunded by a person first, never waved away here;
 *  - voids every unpaid invoice (SCHEDULED / ISSUED / OVERDUE) with its ledger
 *    reversal and an audit row, so no bill is left open — or reminded — for a
 *    rental that will not happen;
 *  - moves the booking to `toStatus` and writes the booking event;
 *  - releases the unit unless another running rental still holds it.
 *
 * The caller decides that the transition is legal (it fires the FSM) and sends
 * any message; this function sends nothing.
 */
export interface CancelUnstartedBookingParams {
  tenantId: string;
  bookingId: string;
  /** Where the booking ends up: REJECTED (staff cancelled) or LAPSED (deadline passed). */
  toStatus: BookingStatus;
  /** Shown on the booking timeline and, prefixed, as each invoice's void reason. */
  reason: string;
  actorType: "USER" | "SYSTEM";
  actorUserId?: string | null;
  /** Also store the reason as the booking's rejectionReason (a staff cancellation). */
  setRejectionReason?: boolean;
}

export type CancelUnstartedBookingResult =
  | { outcome: "cancelled"; fromStatus: BookingStatus; voidedInvoiceIds: string[]; assetReleased: boolean }
  | { outcome: "blocked_by_payment"; invoiceNumber: string }
  | { outcome: "not_found" };

/** Statuses in which a rental holds its unit; one of them on another booking keeps the unit taken. */
const HOLDING_STATUSES: BookingStatus[] = ["ACTIVE", "RENEWING", "SUSPENDED", "NOTICE_GIVEN", "DEFAULT", "PAID", "CHECKED_IN", "PICKED_UP"];

export async function cancelUnstartedBooking(tx: Prisma.TransactionClient, params: CancelUnstartedBookingParams): Promise<CancelUnstartedBookingResult> {
  const booking = await tx.booking.findUnique({ where: { id: params.bookingId } });
  if (!booking || booking.tenantId !== params.tenantId) return { outcome: "not_found" };

  const invoices = await tx.invoice.findMany({ where: { bookingId: booking.id }, include: { payments: { select: { status: true } } } });
  const paid = invoices.find(
    (i) => ["PAID", "PARTIALLY_REFUNDED"].includes(i.status) || i.payments.some((p) => p.status === "SUCCEEDED" || p.status === "PENDING"),
  );
  if (paid) return { outcome: "blocked_by_payment", invoiceNumber: paid.invoiceNumber };

  const voidReason = `Booking cancelled: ${params.reason}`;
  const voidedInvoiceIds: string[] = [];
  for (const invoice of invoices.filter((i) => ["SCHEDULED", "ISSUED", "OVERDUE"].includes(i.status))) {
    await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: "VOID", voidedAt: new Date(), voidedByUserId: params.actorUserId ?? null, voidReason },
    });
    await recordInvoiceVoidedEntries(tx, params.tenantId, invoice.id);
    await tx.auditLog.create({
      data: { tenantId: params.tenantId, actorUserId: params.actorUserId ?? null, action: "INVOICE_VOID", entityType: "Invoice", entityId: invoice.id, metadata: { reason: voidReason } },
    });
    voidedInvoiceIds.push(invoice.id);
  }

  await tx.booking.update({
    where: { id: booking.id },
    data: { status: params.toStatus, ...(params.setRejectionReason ? { rejectionReason: params.reason } : {}) },
  });

  let assetReleased = false;
  if (booking.assetId) {
    const stillHeld = await tx.booking.count({ where: { assetId: booking.assetId, id: { not: booking.id }, status: { in: HOLDING_STATUSES } } });
    if (stillHeld === 0) {
      const asset = await tx.asset.findUnique({ where: { id: booking.assetId } });
      if (asset && (asset.status === "RESERVED" || asset.status === "OCCUPIED")) {
        await tx.asset.update({ where: { id: asset.id }, data: { status: "AVAILABLE" } });
        assetReleased = true;
      }
    }
  }

  await tx.bookingEvent.create({
    data: {
      tenantId: params.tenantId,
      bookingId: booking.id,
      fromStatus: booking.status,
      toStatus: params.toStatus,
      actorType: params.actorType,
      actorId: params.actorUserId ?? null,
      reason: params.reason,
    },
  });

  return { outcome: "cancelled", fromStatus: booking.status, voidedInvoiceIds, assetReleased };
}
