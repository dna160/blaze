/**
 * PRD go-live §5.3 — unit import from the CLI (same engine as Console →
 * Inventory → Import units).
 *
 *   pnpm import:units --tenant city-storage-kebon-jeruk --file kebon-jeruk-units.csv [--apply]
 */
import { readFile } from "node:fs/promises";

import { applyUnitImport, planUnitImport, withTenantContext } from "@rentos/database";

import { args, fail, ownerClient, tenantBySlug, userPath } from "./common.js";

async function main() {
  const a = args();
  if (typeof a.tenant !== "string" || typeof a.file !== "string") fail("Usage: pnpm import:units --tenant <slug> --file <csv> [--apply]");
  const prisma = ownerClient();
  const tenant = await tenantBySlug(prisma, a.tenant);
  const csv = await readFile(userPath(a.file), "utf8");
  const plan = await withTenantContext(prisma, tenant.id, (tx) => planUnitImport(tx, tenant.id, csv));
  console.log(`Units into ${tenant.name}: create ${plan.summary.create}, update ${plan.summary.update}, unchanged ${plan.summary.unchanged}, errors ${plan.summary.error}`);
  const errors = plan.rows.filter((r) => r.errors.length);
  for (const r of errors.slice(0, 50)) console.log(`  line ${r.line} ${r.code || "(no code)"}: ${r.errors.join("; ")}`);
  if (errors.length > 50) console.log(`  … and ${errors.length - 50} more`);
  if (plan.missingFromFile.length) console.log(`  in RentOS but not in the file (kept): ${plan.missingFromFile.join(", ")}`);
  if (!plan.canApply) fail("Not applied: every row needs a code, a zone and a known unit_type_slug.");
  if (!a.apply) return console.log("✔ Dry run clean. Re-run with --apply.");
  const location = await withTenantContext(prisma, tenant.id, (tx) => tx.location.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } }));
  await withTenantContext(prisma, tenant.id, (tx) => applyUnitImport(tx, tenant.id, csv, { locationId: location?.id ?? null }));
  console.log("✔ Applied.");
  await prisma.$disconnect();
}

void main().catch((e) => fail((e as Error).stack ?? String(e)));
