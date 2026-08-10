/**
 * Regression for the self-review finding: the waitlist payment-TTL sweep must
 * VOID the fired invoice AND reverse its ledger entries, so no phantom A/R or
 * revenue survives. Fires an entry (ISSUED invoice + ledger), lapses the TTL,
 * runs runWaitlistExpiry(), and asserts invoice VOID + entry EXPIRED + ledger
 * balanced with ZERO net contribution from the voided invoice.
 *
 * Run: DATABASE_URL=... DATABASE_URL_APP=... tsx apps/api/scripts/waitlist-expiry-verify.ts
 */
import { PrismaClient, fireNextWaitlistEntry, withTenantContext } from "@rentos/database";

import { runWaitlistExpiry } from "../../worker/src/jobs/waitlist-expiry.job.js";

const ORG = "00000000-0000-0000-0000-0000000000b0";
const TEN = "00000000-0000-0000-0000-0000000000b1";
const AT = "00000000-0000-0000-0000-0000000000b2";
const ASSET = "00000000-0000-0000-0000-0000000000b3";
const CUST = "00000000-0000-0000-0000-0000000000b4";
const PRICE = { basePrice: 1000000, currency: "IDR", adminFee: 50000, depositRule: { type: "FIXED", amount: 500000 }, taxInclusive: false };

async function main() {
  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
  for (const t of ["waitlist_entries", "invoice_lines", "ledger_entries", "invoices", "contracts", "rental_order_events", "rental_orders", "customers", "assets", "asset_types", "tenants"]) {
    await db.$executeRawUnsafe(`DELETE FROM ${t} WHERE ${t === "tenants" ? "id" : "tenant_id"} = '${TEN}'`);
  }
  await db.$executeRawUnsafe(`DELETE FROM organizations WHERE id = '${ORG}'`);
  await db.organization.create({ data: { id: ORG, slug: "wx-org", name: "WX Org" } });
  await db.tenant.create({ data: { id: TEN, organizationId: ORG, slug: "wx-test", name: "WX Test", isPkp: true } });
  await db.assetType.create({ data: { id: AT, tenantId: TEN, name: "U", slug: "u", bookingModel: "RECURRING_LEASE", pricing: PRICE } });
  await db.asset.create({ data: { id: ASSET, tenantId: TEN, assetTypeId: AT, code: "U-01", status: "AVAILABLE" } });
  await db.customer.create({ data: { id: CUST, tenantId: TEN, phone: "+62600", type: "INDIVIDUAL", kycStatus: "VERIFIED" } });
  await db.waitlistEntry.create({ data: { tenantId: TEN, assetTypeId: AT, customerId: CUST, position: 1, status: "ARMED", kycVerified: true, priceSnapshot: PRICE } });

  // Fire the entry (creates ISSUED invoice + ledger entries), then lapse its TTL.
  const app = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL_APP! } } });
  const fired = await withTenantContext(app, TEN, (tx) =>
    fireNextWaitlistEntry(tx, { tenantId: TEN, tenantSlug: "wx-test", isPkp: true, assetId: ASSET, ttlHours: 24 }),
  );
  await db.waitlistEntry.updateMany({ where: { tenantId: TEN, status: "FIRED" }, data: { expiresAt: new Date(Date.now() - 60_000) } });

  const balBefore = await ledgerBalanced(db);

  await runWaitlistExpiry(); // the fixed sweep

  const inv = await db.invoice.findUniqueOrThrow({ where: { id: fired!.invoiceId } });
  const entry = await db.waitlistEntry.findFirstOrThrow({ where: { tenantId: TEN } });
  const order = await db.rentalOrder.findUniqueOrThrow({ where: { id: fired!.orderId } });
  const asset = await db.asset.findUniqueOrThrow({ where: { id: ASSET } });
  const balAfter = await ledgerBalanced(db);
  const net = await db.$queryRawUnsafe<Array<{ entry_type: string; sum: string }>>(
    `SELECT entry_type, coalesce(sum(amount),0)::text AS sum FROM ledger_entries WHERE tenant_id='${TEN}' AND reference_id='${inv.id}' GROUP BY entry_type`,
  );
  const nd = Number(net.find((r) => r.entry_type === "DEBIT")?.sum ?? 0);
  const nc = Number(net.find((r) => r.entry_type === "CREDIT")?.sum ?? 0);

  const pass = balBefore && balAfter && inv.status === "VOID" && entry.status === "EXPIRED" && order.status === "CANCELLED" && asset.status === "AVAILABLE" && Math.abs(nd - nc) < 0.01;
  console.log("=== waitlist TTL expiry — ledger reversal regression ===");
  console.log(`ledger balanced before: ${balBefore}, after: ${balAfter}`);
  console.log(`invoice: ${inv.status} (expect VOID); entry: ${entry.status} (expect EXPIRED); order: ${order.status} (expect CANCELLED); asset: ${asset.status} (expect AVAILABLE)`);
  console.log(`voided invoice net ledger: DEBIT=${nd} CREDIT=${nc} (issue+reversal cancel)`);
  console.log(pass ? "RESULT: PASS ✅" : "RESULT: FAIL ❌");

  await db.$disconnect(); await app.$disconnect();
  process.exit(pass ? 0 : 1);
}

async function ledgerBalanced(db: PrismaClient): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<Array<{ entry_type: string; sum: string }>>(
    `SELECT entry_type, coalesce(sum(amount),0)::text AS sum FROM ledger_entries WHERE tenant_id='${TEN}' GROUP BY entry_type`,
  );
  const d = Number(rows.find((r) => r.entry_type === "DEBIT")?.sum ?? 0);
  const c = Number(rows.find((r) => r.entry_type === "CREDIT")?.sum ?? 0);
  return Math.abs(d - c) < 0.01;
}

main().catch((e) => { console.error(e); process.exit(1); });
