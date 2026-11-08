/**
 * PRD go-live §4.4 — staff accounts from go-live-users.csv. This is how the
 * FIRST Super Admin gets into a fresh production database (SEED_MODE=production
 * creates no users). Nobody gets a password: each new account gets a single-use
 * set-password link, printed here for the operator to hand over in person or
 * by WhatsApp.
 *
 *   pnpm import:users --org city-storage --file go-live-users.csv [--apply]
 *
 * CONSOLE_BASE_URL is the console's public URL (for the links).
 */
import { readFile } from "node:fs/promises";

import { applyUserImport, planUserImport } from "@rentos/database";

import { args, fail, ownerClient, userPath } from "./common.js";

async function main() {
  const a = args();
  if (typeof a.org !== "string" || typeof a.file !== "string") fail("Usage: pnpm import:users --org <organization-slug> --file <csv> [--apply]");
  const prisma = ownerClient();
  const org = await prisma.organization.findUnique({ where: { slug: a.org }, select: { id: true, name: true } });
  if (!org) fail(`No organization with slug "${a.org}".`);
  const params = { organizationId: org.id, csv: await readFile(userPath(a.file), "utf8"), defaultTenantId: null, allowOrganizationScope: true };
  const plan = await planUserImport(prisma, params);
  console.log(`Staff for ${org.name}: create ${plan.summary.create}, already exist ${plan.summary.exists}, errors ${plan.summary.error}`);
  for (const r of plan.rows) console.log(`  line ${r.line} ${r.email || "(no email)"} ${r.role} ${r.scope} ${r.branchSlug ?? ""} → ${r.action}${r.errors.length ? `: ${r.errors.join("; ")}` : ""}`);
  if (!plan.canApply) fail("Not applied: fix the rows above.");
  if (!a.apply) return console.log("✔ Dry run clean. Re-run with --apply.");
  const { created } = await applyUserImport(prisma, params);
  const base = (process.env.CONSOLE_BASE_URL ?? "http://localhost:3001").replace(/\/$/, "");
  console.log("\nSet-password links (single use, 72 hours). Hand each one to its owner only:");
  for (const c of created) console.log(`  ${c.email}  ${base}/set-password?token=${c.token}&branch=${c.branchSlug}`);
  await prisma.$disconnect();
}

void main().catch((e) => fail((e as Error).stack ?? String(e)));
