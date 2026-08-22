import { fireNextWaitlistEntry, getPrismaClient, withTenantContext } from "@rentos/database";

/**
 * BUILD-SPEC B1 — no customer reply to a renewal offer by H-7 = auto-decline and
 * RELEASE TO WAITLIST (the client's chosen rule). For every RENEWAL_OFFERED order
 * whose offer was made ≥7 days ago with no response, mark RENEWAL_DECLINED, free
 * the unit, and fire the next armed waitlist entry (shared single-fire path).
 */
const NO_REPLY_DAYS = 7; // H-7

function ttlHours(featureFlags: unknown): number {
  const v = (featureFlags as Record<string, unknown> | null)?.["waitlistPaymentTtlHours"];
  return typeof v === "number" && v > 0 ? v : 24;
}

export async function runRenewalTimeouts(): Promise<void> {
  const prisma = getPrismaClient();
  const tenants = await prisma.tenant.findMany();
  const cutoff = new Date(Date.now() - NO_REPLY_DAYS * 86_400_000);

  for (const tenant of tenants) {
    await withTenantContext(prisma, tenant.id, async (tx) => {
      const stale = await tx.rentalOrder.findMany({
        where: { status: "RENEWAL_OFFERED", renewalRespondedAt: null, renewalOfferedAt: { lte: cutoff } },
      });
      for (const order of stale) {
        await tx.rentalOrder.update({
          where: { id: order.id },
          data: { status: "RENEWAL_DECLINED", renewalRespondedAt: new Date() },
        });
        await tx.rentalOrderEvent.create({
          data: { tenantId: tenant.id, rentalOrderId: order.id, fromStatus: "RENEWAL_OFFERED", toStatus: "RENEWAL_DECLINED", actorType: "SYSTEM", reason: "B1: no reply by H-7 — auto-declined, released to waitlist" },
        });
        if (order.assetId) {
          await tx.asset.update({ where: { id: order.assetId }, data: { status: "AVAILABLE" } });
          await fireNextWaitlistEntry(tx, {
            tenantId: tenant.id,
            tenantSlug: tenant.slug,
            isPkp: tenant.isPkp,
            assetId: order.assetId,
            ttlHours: ttlHours(tenant.featureFlags),
          });
        }
      }
    });
  }
}
