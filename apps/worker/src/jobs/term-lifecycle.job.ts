import { getPrismaClient, voidScheduledInvoices, withTenantContext, type Prisma } from "@rentos/database";
import { recurringLeaseBookingFsm, type BookingActivationContext } from "@rentos/domain";

import { notifyCustomer } from "../notify.js";

function formatDateId(d: Date): string {
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
}

/** Free a unit physically only if no other live booking still holds it (a future booking on the same unit is fine — it isn't physically there yet). */
async function releaseAsset(tx: Prisma.TransactionClient, assetId: string, exceptBookingId: string) {
  const stillHeld = await tx.booking.count({
    where: { assetId, id: { not: exceptBookingId }, status: { in: ["ACTIVE", "RENEWING", "SUSPENDED", "NOTICE_GIVEN", "DEFAULT", "PAID", "CHECKED_IN", "PICKED_UP"] } },
  });
  if (stillHeld > 0) return;
  const asset = await tx.asset.findUnique({ where: { id: assetId } });
  if (asset && (asset.status === "RESERVED" || asset.status === "OCCUPIED")) {
    await tx.asset.update({ where: { id: assetId }, data: { status: "AVAILABLE" } });
  }
}

/**
 * PRD v2 P6 — the lifecycle clock for RECURRING_LEASE bookings, run daily:
 *
 *  1. Stale requests: PENDING_APPROVAL past `reservedUntil` -> EXPIRED
 *     (PRD §8.1's 48h soft-reserve TTL, documented since Session 1 but
 *     never enforced until now). Unit released, customer told to re-request.
 *  2. End of term: ACTIVE/RENEWING/SUSPENDED term leases whose endDate has
 *     passed -> MOVED_OUT. The unit goes back to AVAILABLE physically; the
 *     date-range engine's blackout month keeps it unbookable to others.
 *     Unpaid invoices stay OVERDUE for collection; the deposit refund stays
 *     a manual finance step (DepositsService), same as every other vertical.
 *  3. Notice effective: NOTICE_GIVEN past noticeEffectiveDate -> MOVED_OUT.
 */
export async function runTermLifecycle(): Promise<void> {
  const prisma = getPrismaClient();
  const tenants = await prisma.tenant.findMany();
  const now = new Date();

  for (const tenant of tenants) {
    await withTenantContext(prisma, tenant.id, async (tx) => {
      // 1. Expire stale soft-reservations.
      const stale = await tx.booking.findMany({
        where: { status: "PENDING_APPROVAL", bookingModel: "RECURRING_LEASE", reservedUntil: { lt: now } },
        include: { customer: true, assetType: true },
      });
      for (const booking of stale) {
        const { to } = await recurringLeaseBookingFsm.fire("PENDING_APPROVAL", "EXPIRE", {} as BookingActivationContext);
        await tx.booking.update({ where: { id: booking.id }, data: { status: to } });
        if (booking.assetId) await releaseAsset(tx, booking.assetId, booking.id);
        await tx.bookingEvent.create({
          data: { tenantId: tenant.id, bookingId: booking.id, fromStatus: "PENDING_APPROVAL", toStatus: to, actorType: "SYSTEM", reason: "Soft-reservation TTL elapsed without a decision" },
        });
        await notifyCustomer({
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          customer: booking.customer,
          templateKey: "booking_expired",
          variables: { assetTypeName: booking.assetType.name },
          link: { purpose: "PORTAL", next: "/" },
        });
      }

      // 2. End of term.
      const ended = await tx.booking.findMany({
        where: { bookingModel: "RECURRING_LEASE", termMonths: { not: null }, status: { in: ["ACTIVE", "RENEWING", "SUSPENDED"] }, endDate: { lte: now } },
        include: { customer: true, asset: true },
      });
      for (const booking of ended) {
        const { to } = await recurringLeaseBookingFsm.fire(booking.status as never, "TERM_ENDED", {} as BookingActivationContext);
        await tx.booking.update({ where: { id: booking.id }, data: { status: to } });
        if (booking.assetId) await releaseAsset(tx, booking.assetId, booking.id);
        // Defensive: in the natural flow every cycle is issued before the term ends; anything
        // still SCHEDULED here (a shortened end date) must never be billed.
        await voidScheduledInvoices(tx, booking.id);
        await tx.bookingEvent.create({
          data: { tenantId: tenant.id, bookingId: booking.id, fromStatus: booking.status, toStatus: to, actorType: "SYSTEM", reason: `Term of ${booking.termMonths} month(s) ended on ${booking.endDate!.toISOString().slice(0, 10)}` },
        });
        await notifyCustomer({
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          customer: booking.customer,
          templateKey: "term_ended",
          variables: { assetCode: booking.asset?.code ?? "", endDate: formatDateId(booking.endDate!) },
          link: { purpose: "BOOKING", next: `/portal/bookings/${booking.id}` },
        });
      }

      // 3. Notice effective.
      const noticed = await tx.booking.findMany({
        where: { bookingModel: "RECURRING_LEASE", status: "NOTICE_GIVEN", noticeEffectiveDate: { lte: now } },
      });
      for (const booking of noticed) {
        const { to } = await recurringLeaseBookingFsm.fire("NOTICE_GIVEN", "END_DATE_REACHED", {} as BookingActivationContext);
        await tx.booking.update({ where: { id: booking.id }, data: { status: to } });
        if (booking.assetId) await releaseAsset(tx, booking.assetId, booking.id);
        await tx.bookingEvent.create({
          data: { tenantId: tenant.id, bookingId: booking.id, fromStatus: "NOTICE_GIVEN", toStatus: to, actorType: "SYSTEM", reason: "Notice effective date reached" },
        });
      }
    });
  }
}
