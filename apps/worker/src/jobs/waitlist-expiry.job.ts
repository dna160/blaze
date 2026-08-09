import { fireNextWaitlistEntry, getPrismaClient, withTenantContext } from "@rentos/database";

/**
 * BUILD-SPEC C5 rule 3 — payment TTL. A fired waitlist entry that goes unpaid
 * past its TTL must not freeze the unit forever. For each such entry: void the
 * fired invoice, mark the entry EXPIRED, cancel its order, free the unit, and
 * fire the next armed entry. Runs frequently (hourly) since the TTL is in hours.
 */
function ttlHours(featureFlags: unknown): number {
  const v = (featureFlags as Record<string, unknown> | null)?.["waitlistPaymentTtlHours"];
  return typeof v === "number" && v > 0 ? v : 24;
}

export async function runWaitlistExpiry(): Promise<void> {
  const prisma = getPrismaClient();
  const tenants = await prisma.tenant.findMany();
  const now = new Date();

  for (const tenant of tenants) {
    await withTenantContext(prisma, tenant.id, async (tx) => {
      const lapsed = await tx.waitlistEntry.findMany({ where: { status: "FIRED", expiresAt: { lt: now } } });
      for (const entry of lapsed) {
        if (!entry.firedRentalOrderId) continue;
        const order = await tx.rentalOrder.findUnique({ where: { id: entry.firedRentalOrderId } });
        if (!order) continue;

        await tx.invoice.updateMany({
          where: { rentalOrderId: order.id, status: { in: ["ISSUED", "SCHEDULED", "OVERDUE"] } },
          data: { status: "VOID", voidedAt: now, voidReason: "Waitlist payment TTL lapsed" },
        });
        await tx.rentalOrder.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
        await tx.waitlistEntry.update({ where: { id: entry.id }, data: { status: "EXPIRED" } });

        if (order.assetId) {
          await tx.asset.update({ where: { id: order.assetId }, data: { status: "AVAILABLE" } });
          // Fire the next armed entry for the freed unit (same tx, own row lock).
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
