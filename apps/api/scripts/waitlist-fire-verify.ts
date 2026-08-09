/**
 * BUILD-SPEC Gate R1 evidence — the waitlist SINGLE-FIRE guarantee under REAL
 * concurrency (not sequential). Two armed waitlisters, one released unit, two
 * concurrent fireNext() calls → exactly ONE RentalOrder + ONE contract must
 * exist, and exactly one entry FIRED (the other still ARMED). Runs the actual
 * WaitlistService against real Postgres as the RLS-enforced rentos_app role.
 *
 * Run: DATABASE_URL=... DATABASE_URL_APP=... JWT_SECRET=x tsx apps/api/scripts/waitlist-fire-verify.ts
 */
import { PrismaClient } from "@rentos/database";

import { PrismaService } from "../src/prisma/prisma.service.js";
import { WaitlistService } from "../src/waitlist/waitlist.service.js";
import type { ResolvedTenant } from "../src/tenancy/tenancy.service.js";

const ORG = "00000000-0000-0000-0000-0000000000f0";
const TEN = "00000000-0000-0000-0000-0000000000f1";
const AT = "00000000-0000-0000-0000-0000000000f2";
const ASSET = "00000000-0000-0000-0000-0000000000f3";
const C1 = "00000000-0000-0000-0000-0000000000f4";
const C2 = "00000000-0000-0000-0000-0000000000f5";

const tenant: ResolvedTenant = {
  id: TEN,
  organizationId: ORG,
  slug: "wl-test",
  name: "WL Test",
  isPkp: true,
  defaultLocale: "id",
  timezone: "Asia/Jakarta",
  featureFlags: {},
};

async function seed(db: PrismaClient) {
  // Clean prior run (children first).
  await db.$executeRawUnsafe(`DELETE FROM waitlist_entries WHERE tenant_id = '${TEN}'`);
  await db.$executeRawUnsafe(`DELETE FROM contracts WHERE tenant_id = '${TEN}'`);
  await db.$executeRawUnsafe(`DELETE FROM invoice_lines WHERE tenant_id = '${TEN}'`);
  await db.$executeRawUnsafe(`DELETE FROM ledger_entries WHERE tenant_id = '${TEN}'`);
  await db.$executeRawUnsafe(`DELETE FROM invoices WHERE tenant_id = '${TEN}'`);
  await db.$executeRawUnsafe(`DELETE FROM rental_order_events WHERE tenant_id = '${TEN}'`);
  await db.$executeRawUnsafe(`DELETE FROM rental_orders WHERE tenant_id = '${TEN}'`);
  await db.$executeRawUnsafe(`DELETE FROM assets WHERE tenant_id = '${TEN}'`);
  await db.$executeRawUnsafe(`DELETE FROM asset_types WHERE tenant_id = '${TEN}'`);
  await db.$executeRawUnsafe(`DELETE FROM customers WHERE tenant_id = '${TEN}'`);
  await db.$executeRawUnsafe(`DELETE FROM tenants WHERE id = '${TEN}'`);
  await db.$executeRawUnsafe(`DELETE FROM organizations WHERE id = '${ORG}'`);

  await db.organization.create({ data: { id: ORG, slug: "wl-test-org", name: "WL Org" } });
  await db.tenant.create({ data: { id: TEN, organizationId: ORG, slug: "wl-test", name: "WL Test", isPkp: true } });
  await db.assetType.create({
    data: {
      id: AT, tenantId: TEN, name: "Unit", slug: "unit", bookingModel: "RECURRING_LEASE",
      pricing: { basePrice: 1000000, currency: "IDR", adminFee: 50000, depositRule: { type: "FIXED", amount: 500000 }, taxInclusive: false },
    },
  });
  await db.asset.create({ data: { id: ASSET, tenantId: TEN, assetTypeId: AT, code: "U-01", status: "AVAILABLE" } });
  for (const [id, phone, pos] of [[C1, "+62811", 1], [C2, "+62822", 2]] as const) {
    await db.customer.create({ data: { id, tenantId: TEN, phone, type: "INDIVIDUAL", kycStatus: "VERIFIED" } });
    await db.waitlistEntry.create({
      data: { tenantId: TEN, assetTypeId: AT, customerId: id, position: pos, status: "ARMED", kycVerified: true,
        priceSnapshot: { basePrice: 1000000, currency: "IDR", adminFee: 50000, depositRule: { type: "FIXED", amount: 500000 }, taxInclusive: false } },
    });
  }
}

async function main() {
  const seedDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
  await seed(seedDb);

  const prisma = new PrismaService(); // uses DATABASE_URL_APP (rentos_app, RLS enforced)
  const waitlist = new WaitlistService(prisma, { notify: async () => {} } as never);

  // Two CONCURRENT fire attempts on the same released unit.
  const results = await Promise.allSettled([waitlist.fireNext(tenant, ASSET), waitlist.fireNext(tenant, ASSET)]);
  const fired = results
    .map((r) => (r.status === "fulfilled" ? r.value : null))
    .filter((v) => v != null);

  const orders = await seedDb.rentalOrder.count({ where: { tenantId: TEN } });
  const contracts = await seedDb.contract.count({ where: { tenantId: TEN } });
  const firedEntries = await seedDb.waitlistEntry.count({ where: { tenantId: TEN, status: "FIRED" } });
  const armedEntries = await seedDb.waitlistEntry.count({ where: { tenantId: TEN, status: "ARMED" } });
  const asset = await seedDb.asset.findUniqueOrThrow({ where: { id: ASSET } });

  const pass =
    fired.length === 1 && orders === 1 && contracts === 1 && firedEntries === 1 && armedEntries === 1 && asset.status === "RESERVED";

  console.log("=== Waitlist single-fire concurrency test ===");
  console.log(`fireNext returned an order: ${fired.length} (expect 1)`);
  console.log(`rental_orders created:      ${orders} (expect 1)`);
  console.log(`contracts created:          ${contracts} (expect 1)`);
  console.log(`entries FIRED:              ${firedEntries} (expect 1)`);
  console.log(`entries still ARMED:        ${armedEntries} (expect 1)`);
  console.log(`asset status:               ${asset.status} (expect RESERVED)`);
  console.log(pass ? "RESULT: PASS ✅" : "RESULT: FAIL ❌");

  await seedDb.$disconnect();
  await prisma.onModuleDestroy();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
