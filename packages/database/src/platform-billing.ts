import { BILLING_PLANS, computeMonthlyCharge, type BillingPlanKey } from "@rentos/domain";

import type { PrismaClient } from "../generated/client/index.js";
import { withTenantContext } from "./tenant-context.js";

/**
 * RentOS's own monthly billing run — one `PlatformInvoice` per tenant per
 * calendar month, generated from that tenant's `billingPlan` and its
 * current active-asset usage. Lives here (not apps/api) for the same
 * reason `invoicing.ts` does: apps/worker's monthly cron and apps/api's
 * on-demand "generate this month's invoices now" trigger (platform
 * console button, since waiting for a real monthly cron isn't demoable
 * live) must call the exact same code path, not two hand-copies of it.
 *
 * Deliberately loops tenants one at a time via `withTenantContext`
 * (mirroring `dunning-ladder.job.ts`'s existing tenant loop) rather than
 * a single cross-tenant query — `rentos_app` has no BYPASSRLS, so there
 * is no query that could see every tenant's assets at once even if one
 * were written; per-tenant iteration is the only shape RLS allows, and
 * at 3-4 tenants the cost is irrelevant.
 *
 * Idempotent per (tenantId, year, month) via the unique constraint:
 * re-running this in the same month before an invoice was already
 * generated is a no-op for that tenant (`skipIfExists`), so an
 * accidental double-click on the console's "Generate" button, or the
 * monthly cron firing on top of an already-manually-triggered run,
 * can't create two invoices for the same period.
 */
export async function generateMonthlyPlatformInvoices(
  prisma: PrismaClient,
  when: Date = new Date(),
): Promise<{ tenantId: string; tenantSlug: string; created: boolean }[]> {
  const year = when.getFullYear();
  const month = when.getMonth() + 1;
  const tenants = await prisma.tenant.findMany();
  const results: { tenantId: string; tenantSlug: string; created: boolean }[] = [];

  for (const tenant of tenants) {
    const created = await withTenantContext(prisma, tenant.id, async (tx) => {
      // platform_invoices is RLS-scoped exactly like every other tenant
      // table, so both the existence check and the insert have to run
      // inside this tenant's own SET LOCAL context — a plain
      // `prisma.platformInvoice.*` call outside withTenantContext would
      // see zero rows and fail the INSERT's WITH CHECK, same as any
      // other tenant-scoped table.
      const existing = await tx.platformInvoice.findUnique({
        where: { tenantId_periodYear_periodMonth: { tenantId: tenant.id, periodYear: year, periodMonth: month } },
      });
      if (existing) return false;

      const activeAssetCount = await tx.asset.count({ where: { status: { not: "RETIRED" } } });
      const plan = tenant.billingPlan as BillingPlanKey;
      const charge = computeMonthlyCharge(plan, activeAssetCount);

      await tx.platformInvoice.create({
        data: {
          tenantId: tenant.id,
          billingPlan: tenant.billingPlan,
          periodYear: year,
          periodMonth: month,
          includedAssets: BILLING_PLANS[plan].includedAssets,
          actualAssetCount: activeAssetCount,
          planAmount: charge.planAmount.toString(),
          overageAmount: charge.overageAmount.toString(),
          totalAmount: charge.totalAmount.toString(),
        },
      });
      return true;
    });
    results.push({ tenantId: tenant.id, tenantSlug: tenant.slug, created });
  }

  return results;
}
