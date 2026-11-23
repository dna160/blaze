import { cancelUnstartedBooking, getPrismaClient, withTenantContext } from "@rentos/database";
import { offlineSignStep, recurringLeaseBookingFsm, type BookingActivationContext } from "@rentos/domain";

import { notifyCustomer } from "../notify.js";

function formatDateId(d: Date): string {
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Jakarta" });
}

/**
 * PRD go-live 2 §5.3 B — the signing deadline for contracts signed on paper at
 * the office, run daily.
 *
 * For every APPROVED booking whose latest contract is OFFLINE, unsigned and has
 * a `signDeadlineAt`:
 *  - 3 days and 1 day before the deadline: remind the customer
 *    (`contract_sign_reminder`) — once per contract per reminder day, so a
 *    re-run on the same day sends nothing new;
 *  - once the deadline has passed: APPROVED → LAPSED (the existing
 *    PAYMENT_TIMEOUT transition), unpaid invoices voided with their ledger
 *    reversal and the unit released — through `cancelUnstartedBooking`, the
 *    same function staff cancellation uses — and the customer is told.
 *    A booking with money in (a payment received or awaiting verification)
 *    is left alone and reported: a person settles it.
 *
 * Untouched: ONLINE contracts, signed contracts, and rentals imported from the
 * legacy system (`legacyBookingNumber` set) — those are signed already and
 * are never lapsed by a job.
 */
export async function runOfflineSignDeadline(now: Date = new Date()): Promise<{ reminded: number; lapsed: number; blocked: number }> {
  const prisma = getPrismaClient();
  const tenants = await prisma.tenant.findMany();
  const totals = { reminded: 0, lapsed: 0, blocked: 0 };

  for (const tenant of tenants) {
    const due = await withTenantContext(prisma, tenant.id, (tx) =>
      tx.contract.findMany({
        where: {
          signMethod: "OFFLINE",
          signedAt: null,
          signDeadlineAt: { not: null },
          booking: { status: "APPROVED", legacyBookingNumber: null },
        },
        include: { booking: { include: { customer: true, asset: { select: { code: true } }, location: { select: { name: true } } } } },
      }),
    );

    for (const contract of due) {
      const booking = contract.booking!;
      // Only the booking's latest contract counts (a regenerated contract supersedes the old one).
      const latest = await withTenantContext(prisma, tenant.id, (tx) =>
        tx.contract.findFirst({ where: { bookingId: booking.id }, orderBy: { createdAt: "desc" }, select: { id: true } }),
      );
      if (latest?.id !== contract.id) continue;

      const deadline = contract.signDeadlineAt!;
      const step = offlineSignStep(deadline, now);
      const common = {
        assetCode: booking.asset?.code ?? "-",
        deadline: formatDateId(deadline),
      };

      if (step.kind === "remind") {
        const already = await withTenantContext(prisma, tenant.id, (tx) =>
          tx.notification.findFirst({
            where: {
              templateKey: "contract_sign_reminder",
              // Per deadline: a deadline restarted by a date change gets its reminders again.
              AND: [
                { payload: { path: ["contractId"], equals: contract.id } },
                { payload: { path: ["daysLeft"], equals: String(step.daysLeft) } },
                { payload: { path: ["deadline"], equals: common.deadline } },
              ],
            },
            select: { id: true },
          }),
        );
        if (already) continue;
        await notifyCustomer({
          tenantId: tenant.id,
          tenantSlug: tenant.slug,
          customer: booking.customer,
          templateKey: "contract_sign_reminder",
          variables: {
            ...common,
            daysLeft: String(step.daysLeft),
            locationName: booking.location?.name ?? tenant.name,
            contractId: contract.id,
          },
          link: { purpose: "BOOKING", next: `/portal/bookings/${booking.id}` },
        });
        // Staff see it on the booking timeline.
        await withTenantContext(prisma, tenant.id, (tx) =>
          tx.bookingEvent.create({
            data: {
              tenantId: tenant.id,
              bookingId: booking.id,
              fromStatus: booking.status,
              toStatus: booking.status,
              actorType: "SYSTEM",
              reason: `Pengingat tanda tangan dikirim — batas ${common.deadline} (${step.daysLeft} hari lagi)`,
            },
          }),
        );
        totals.reminded++;
        continue;
      }

      if (step.kind !== "lapse") continue;

      const { to } = await recurringLeaseBookingFsm.fire("APPROVED", "PAYMENT_TIMEOUT", {} as BookingActivationContext);
      const result = await withTenantContext(prisma, tenant.id, (tx) =>
        cancelUnstartedBooking(tx, {
          tenantId: tenant.id,
          bookingId: booking.id,
          toStatus: to,
          reason: `Kontrak tidak ditandatangani sampai batas ${common.deadline} (tanda tangan di kantor)`,
          actorType: "SYSTEM",
        }),
      );
      if (result.outcome === "blocked_by_payment") {
        totals.blocked++;
        console.warn(`[offline-sign-deadline] ${tenant.slug} booking ${booking.id}: deadline passed but invoice ${result.invoiceNumber} has a payment — left for staff.`);
        continue;
      }
      if (result.outcome !== "cancelled") continue;
      await withTenantContext(prisma, tenant.id, (tx) =>
        tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            action: "BOOKING_LAPSED_UNSIGNED",
            entityType: "Booking",
            entityId: booking.id,
            metadata: { contractId: contract.id, signDeadlineAt: deadline.toISOString(), voidedInvoiceIds: result.voidedInvoiceIds, assetReleased: result.assetReleased },
          },
        }),
      );
      await notifyCustomer({
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        customer: booking.customer,
        templateKey: "contract_sign_lapsed",
        variables: common,
      });
      totals.lapsed++;
    }
  }

  console.log(`[offline-sign-deadline] reminded ${totals.reminded}, lapsed ${totals.lapsed}, blocked by payment ${totals.blocked}`);
  return totals;
}
