import { generateMonthlyPlatformInvoices, getPrismaClient } from "@rentos/database";

/**
 * RentOS's own monthly billing run (Session 26, PRD Phase 4 tenant
 * billing/metering). Thin wrapper around the shared orchestration in
 * packages/database/src/platform-billing.ts — the same function
 * apps/api's on-demand "Generate this month's invoices now" console
 * button calls, so a real monthly cron tick and a manual demo trigger
 * can never drift into two different implementations.
 */
export async function runPlatformBilling(): Promise<void> {
  const prisma = getPrismaClient();
  const results = await generateMonthlyPlatformInvoices(prisma);
  const createdCount = results.filter((r) => r.created).length;
  console.log(`[platform-billing] generated ${createdCount} new invoice(s) across ${results.length} tenant(s)`);
}
