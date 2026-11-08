/**
 * PRD go-live §10 — migrate a branch's live book from Booqable.
 *
 *   pnpm migrate:legacy --tenant city-storage-kebon-jeruk --dir ./import [--apply]
 *                       [--min-contract-seq 39] [--min-invoice-seq 122]
 *
 * --dir holds migration-customers.csv, migration-rentals.csv and
 * migration-open-invoices.csv (templates: packages/database/prisma/data/
 * kebon-jeruk/), plus the signed contract PDFs named in the rentals file.
 * Dry run unless --apply; --apply refuses unless the dry run is clean.
 * Refuses outright unless messaging is paused.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { applyLegacyImport, planLegacyImport, type LegacyInput, type LegacyPlan } from "@rentos/database";

import { args, fail, ownerClient, storage, tenantBySlug, userPath } from "./common.js";

function idr(n: number) {
  return `Rp ${new Intl.NumberFormat("id-ID").format(n)}`;
}

function report(plan: LegacyPlan) {
  const errors = plan.findings.filter((f) => f.level === "error");
  const warnings = plan.findings.filter((f) => f.level === "warning");
  console.log("\nWould create / update");
  console.log(`  customers      ${plan.counts.customers.create} / ${plan.counts.customers.update}`);
  console.log(`  rentals        ${plan.counts.rentals.create} / ${plan.counts.rentals.update}`);
  console.log(`  open invoices  ${plan.counts.openInvoices.create} / ${plan.counts.openInvoices.update}`);
  console.log("\nReconcile against Booqable before applying (§10.2 step 2)");
  console.log(`  active rentals     ${plan.totals.activeRentals}`);
  console.log(`  monthly rent       ${idr(plan.totals.monthlyRent)}`);
  console.log(`  AR outstanding     ${idr(plan.totals.arOutstanding)}`);
  console.log(`  deposits held      ${idr(plan.totals.depositsHeld)}`);
  console.log(`  counters continue  customer > ${plan.maxLegacy.customerNumber}, contract > ${plan.maxLegacy.contractSeq}, invoice > ${plan.maxLegacy.invoiceSeq}`);
  for (const [title, list] of [["Errors", errors], ["Warnings", warnings]] as const) {
    if (!list.length) continue;
    console.log(`\n${title} (${list.length})`);
    for (const f of list) console.log(`  ${f.file}${f.line ? `:${f.line}` : ""} [${f.key}] ${f.message}`);
  }
}

async function main() {
  const a = args();
  const slug = a.tenant;
  const dir = typeof a.dir === "string" ? userPath(a.dir) : undefined;
  if (typeof slug !== "string" || typeof dir !== "string") fail("Usage: pnpm migrate:legacy --tenant <slug> --dir <folder> [--apply]");
  const prisma = ownerClient();
  const tenant = await tenantBySlug(prisma, slug);
  const store = storage();
  const read = (name: string) => readFile(path.join(dir, name), "utf8").catch(() => fail(`Missing ${path.join(dir, name)}`));
  const input: LegacyInput = {
    customersCsv: await read("migration-customers.csv"),
    rentalsCsv: await read("migration-rentals.csv"),
    openInvoicesCsv: await read("migration-open-invoices.csv"),
    readFile: async (rel) => readFile(path.join(dir, rel)).catch(() => null),
    storeFile: async (key, buffer, contentType) => (await store.save({ key, buffer, contentType })).storageKey,
    minContractSeq: a["min-contract-seq"] ? Number(a["min-contract-seq"]) : undefined,
    minInvoiceSeq: a["min-invoice-seq"] ? Number(a["min-invoice-seq"]) : undefined,
  };

  console.log(`Legacy migration into ${tenant.name} (${tenant.slug}) — ${a.apply ? "APPLY" : "dry run"}`);
  const { plan } = await planLegacyImport(prisma, tenant.id, input);
  report(plan);
  if (!plan.canApply) fail("Not applied: fix the errors above and run the dry run again.");
  if (!a.apply) {
    console.log("\n✔ Dry run clean. Re-run with --apply to write it.\n");
    return;
  }
  const result = await applyLegacyImport(prisma, tenant.id, input);
  if (!result.applied) fail("Not applied: the data changed between the dry run and apply — run again.");
  console.log("\n✔ Applied. Spot-check 10 customers with the branch, then review the SUPPRESSED queue before unpausing messaging.\n");
  await prisma.$disconnect();
}

void main().catch((e) => fail((e as Error).stack ?? String(e)));
