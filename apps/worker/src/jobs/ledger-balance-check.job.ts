import { computeLedgerBalance, getPrismaClient, withTenantContext } from "@rentos/database";

/**
 * PRD §10 Reliability: "double-entry ledger balances checked nightly."
 * A genuine double-entry ledger always has sum(debits) == sum(credits)
 * across all accounts combined — any drift means a code path wrote one
 * side of an entry without the other, which should never happen if every
 * ledger write goes through packages/database/src/ledger.ts's paired
 * helpers. This job is the tripwire that catches it if it ever does.
 *
 * v1 only logs on drift (loud enough to show up in Railway logs / any log
 * aggregation attached later) — routing this to a real alert channel is a
 * follow-up, tracked in docs/HANDOFF.md.
 */
export async function runLedgerBalanceCheck(): Promise<void> {
  const prisma = getPrismaClient();
  const tenants = await prisma.tenant.findMany();

  for (const tenant of tenants) {
    const balance = await withTenantContext(prisma, tenant.id, (tx) => computeLedgerBalance(tx, tenant.id));
    if (!balance.balanced) {
      console.error(
        `[ledger-balance-check] UNBALANCED LEDGER for tenant ${tenant.slug} (${tenant.id}): ` +
          `debits=${balance.totalDebits} credits=${balance.totalCredits} diff=${(balance.totalDebits - balance.totalCredits).toFixed(2)}`,
      );
    } else {
      console.log(`[ledger-balance-check] tenant ${tenant.slug}: balanced (debits=${balance.totalDebits})`);
    }
  }
}
