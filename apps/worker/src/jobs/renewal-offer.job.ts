import { getPrismaClient, withTenantContext } from "@rentos/database";

import { notify } from "../notify.js";

/**
 * BUILD-SPEC C4 — H-14 renewal offer. For every ACTIVE RentalOrder whose period
 * ends in ~14 days, move it to RENEWAL_OFFERED and prompt the customer to
 * confirm. Confirmation spawns a NEW order (RentalOrderService.confirmRenewal);
 * no reply by H-7 is auto-declined by renewal-timeout.job (B1).
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
    const toNotify = await withTenantContext(prisma, tenant.id, async (tx) => {
      const due = await tx.rentalOrder.findMany({
        where: { status: "ACTIVE", periodEnd: { gte: lower, lte: upper } },
        include: { customer: true },
      });
      const out: Array<{ customerId: string; phone: string; orderId: string }> = [];
      for (const order of due) {
        await tx.rentalOrder.update({ where: { id: order.id }, data: { status: "RENEWAL_OFFERED", renewalOfferedAt: now } });
        await tx.rentalOrderEvent.create({
          data: { tenantId: tenant.id, rentalOrderId: order.id, fromStatus: "ACTIVE", toStatus: "RENEWAL_OFFERED", actorType: "SYSTEM", reason: "H-14 renewal offer" },
        });
        out.push({ customerId: order.customerId, phone: order.customer.phone, orderId: order.id });
      }
      return out;
    });

    for (const n of toNotify) {
      await notify({
        tenantId: tenant.id,
        customerId: n.customerId,
        templateKey: "renewal_offer_h14",
        recipient: n.phone,
        variables: { orderId: n.orderId },
      });
    }
  }
}
