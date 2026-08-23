import { getPrismaClient, withTenantContext } from "@rentos/database";

import { notifyCustomer } from "../notify.js";

/**
 * H-14 renewal offer, on both rental shapes.
 *
 * BUILD-SPEC C4 wrote this as a per-month gate: every month is its own
 * RentalOrder and none of them bills without the customer confirming. PRD v2 D1
 * (later, owner-confirmed) sells a 1/3/6/12-month TERM and materialises its
 * whole payment schedule at contract time, which finance ages forward.
 *
 * Those only conflict if you read C4 as "confirm every month". The concern it
 * was written for is a contract that renews silently forever — the client's
 * "monthly, no end date" problem. A signed term is already closed-ended and
 * already committed to, so a mid-term gate asks the customer to re-agree to
 * something they signed; at the TERM BOUNDARY the same gate is exactly what
 * stops the silent roll-over. So:
 *
 *   - Term Booking (PRD v2): one offer, 14 days before `endDate`. No reply and
 *     term-lifecycle.job ends the lease at endDate (blackout still holds the
 *     unit) — declining is the default, which is what makes it enforceable.
 *   - RentalOrder (BUILD-SPEC C4): unchanged, for tenants on the per-order
 *     model. renewal-timeout.job auto-declines at H-7 (B1).
 *
 * Both windows are [now+13d, now+14d] on a daily job, so each subject is caught
 * exactly once without needing a "already offered" flag.
 */
const OFFER_LEAD_DAYS = 14;

export async function runRenewalOffers(): Promise<void> {
  const prisma = getPrismaClient();
  const tenants = await prisma.tenant.findMany();
  const now = new Date();
  const lower = new Date(now.getTime() + (OFFER_LEAD_DAYS - 1) * 86_400_000);
  const upper = new Date(now.getTime() + OFFER_LEAD_DAYS * 86_400_000);

  for (const tenant of tenants) {
    // Transition inside the tenant transaction; collect who to notify, then send
    // AFTER it commits (notify opens its own tenant transactions — never nest).
    const orderOffers = await withTenantContext(prisma, tenant.id, async (tx) => {
      const due = await tx.rentalOrder.findMany({
        where: { status: "ACTIVE", periodEnd: { gte: lower, lte: upper } },
        include: { customer: true },
      });
      const out = [];
      for (const order of due) {
        await tx.rentalOrder.update({ where: { id: order.id }, data: { status: "RENEWAL_OFFERED", renewalOfferedAt: now } });
        await tx.rentalOrderEvent.create({
          data: { tenantId: tenant.id, rentalOrderId: order.id, fromStatus: "ACTIVE", toStatus: "RENEWAL_OFFERED", actorType: "SYSTEM", reason: "H-14 renewal offer" },
        });
        out.push({ customer: order.customer, orderId: order.id });
      }
      return out;
    });

    for (const n of orderOffers) {
      await notifyCustomer({
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        customer: n.customer,
        templateKey: "renewal_offer_h14",
        variables: { orderId: n.orderId },
        link: { purpose: "BOOKING", next: `/portal/bookings/${n.orderId}` },
      });
    }

    // Term leases: read-only here — the offer is a message, and the lease only
    // changes state at endDate (term-lifecycle) or when the customer acts.
    const termOffers = await withTenantContext(prisma, tenant.id, (tx) =>
      tx.booking.findMany({
        where: {
          bookingModel: "RECURRING_LEASE",
          status: { in: ["ACTIVE", "RENEWING"] },
          termMonths: { not: null },
          endDate: { gte: lower, lte: upper },
        },
        include: { customer: true, assetType: { select: { name: true } }, asset: { select: { code: true } } },
      }),
    );

    for (const booking of termOffers) {
      await notifyCustomer({
        tenantId: tenant.id,
        tenantSlug: tenant.slug,
        customer: booking.customer,
        templateKey: "term_renewal_offer_h14",
        variables: {
          bookingId: booking.id,
          assetTypeName: booking.assetType.name,
          assetCode: booking.asset?.code ?? "",
          termMonths: String(booking.termMonths ?? ""),
          endDate: booking.endDate ? booking.endDate.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" }) : "",
        },
        link: { purpose: "BOOKING", next: `/portal/bookings/${booking.id}` },
      });
    }
  }
}
