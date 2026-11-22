import { accrueLateFees, accrueOverstay, getPrismaClient, raiseDepositRefundTasks, withTenantContext } from "@rentos/database";
import { resolveMoneyRules } from "@rentos/domain";

import { notify } from "../notify.js";

/** The calendar date of `at` in `timeZone`, as YYYY-MM-DD. */
function zonedToday(at: Date, timeZone: string): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  return p; // en-CA formats as YYYY-MM-DD
}

/**
 * PRD go-live 2 §10.3 — the T&C money rules, daily, per branch. Each rule is
 * off unless the branch turned it on (`featureFlags.moneyRules`), and each
 * step is idempotent (a re-run charges nothing twice; a missed day is caught
 * up on the next run):
 *  - late fee (V.3) and overstay (VI.4) lines;
 *  - deposit refund tasks (IV.3): raised once per deposit when its refund
 *    due date passes; the branch admin (featureFlags.adminNotifyRecipient)
 *    gets one message listing them.
 * Overtime (II.8) is staff-entered, and the arrears badge (V.5) is computed
 * on read — neither needs the job.
 */
export async function runMoneyRules(now: Date = new Date()) {
  const prisma = getPrismaClient();
  const tenants = await prisma.tenant.findMany({ select: { id: true, slug: true, timezone: true, featureFlags: true } });
  const summary: Record<string, unknown> = {};
  for (const tenant of tenants) {
    const rules = resolveMoneyRules(tenant.featureFlags);
    if (!rules.lateFee.enabled && !rules.overstay.enabled && !rules.depositRefundTask.enabled) continue;
    const today = zonedToday(now, tenant.timezone || "Asia/Jakarta");
    const result = await withTenantContext(
      prisma,
      tenant.id,
      async (tx) => ({
        lateFees: await accrueLateFees(tx, tenant, rules, today),
        overstay: await accrueOverstay(tx, tenant, rules, today),
        refundTasks: await raiseDepositRefundTasks(tx, tenant.id, rules, now),
      }),
      { timeout: 120_000, maxWait: 20_000 },
    );
    summary[tenant.slug] = { lateFees: result.lateFees, overstay: result.overstay, refundTasks: result.refundTasks.length };
    console.log(`[money-rules] ${tenant.slug} ${today}: ${JSON.stringify(summary[tenant.slug])}`);

    const admin = (tenant.featureFlags as Record<string, unknown> | null)?.["adminNotifyRecipient"];
    if (result.refundTasks.length > 0 && typeof admin === "string" && admin) {
      await notify({
        tenantId: tenant.id,
        templateKey: "deposit_refund_task",
        recipient: admin,
        recipientRole: "ADMIN",
        variables: {
          count: String(result.refundTasks.length),
          list: result.refundTasks.map((d) => `${d.unit ?? "-"} #${d.customerNumber ?? "-"} ${d.customerName ?? ""} Rp ${Number(d.amount).toLocaleString("id-ID")}`).join("; "),
        },
      });
    }
  }
  return summary;
}
