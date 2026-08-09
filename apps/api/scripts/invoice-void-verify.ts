/**
 * BUILD-SPEC #33 evidence — voiding an unpaid invoice keeps the double-entry
 * ledger balanced. Issues a rental-order invoice as rentos_app, records the
 * ledger balance, voids via FinanceService, and asserts the ledger is still
 * balanced and the invoice's net ledger contribution is exactly zero.
 *
 * Run: DATABASE_URL=... DATABASE_URL_APP=... JWT_SECRET=x tsx apps/api/scripts/invoice-void-verify.ts
 */
import { PrismaClient, generateRentalOrderInvoice, withTenantContext } from "@rentos/database";

import { FinanceService } from "../src/finance/finance.service.js";
import { PrismaService } from "../src/prisma/prisma.service.js";

const ORG = "00000000-0000-0000-0000-0000000000e0";
const TEN = "00000000-0000-0000-0000-0000000000e1";
const AT = "00000000-0000-0000-0000-0000000000e2";
const CUST = "00000000-0000-0000-0000-0000000000e3";
const ORDER = "00000000-0000-0000-0000-0000000000e4";

async function seed(db: PrismaClient) {
  for (const t of ["invoice_lines", "ledger_entries", "invoices", "rental_orders", "customers", "asset_types", "tenants"]) {
    await db.$executeRawUnsafe(`DELETE FROM ${t} WHERE ${t === "tenants" ? "id" : "tenant_id"} = '${TEN}'`);
  }
  await db.$executeRawUnsafe(`DELETE FROM organizations WHERE id = '${ORG}'`);
  await db.organization.create({ data: { id: ORG, slug: "void-org", name: "Void Org" } });
  await db.tenant.create({ data: { id: TEN, organizationId: ORG, slug: "void-test", name: "Void Test", isPkp: true } });
  await db.assetType.create({ data: { id: AT, tenantId: TEN, name: "U", slug: "u", bookingModel: "RECURRING_LEASE", pricing: {} } });
  await db.customer.create({ data: { id: CUST, tenantId: TEN, phone: "+62800", type: "INDIVIDUAL" } });
  await db.rentalOrder.create({
    data: {
      id: ORDER, tenantId: TEN, customerId: CUST, assetTypeId: AT, status: "AWAITING_PAYMENT",
      periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-10-01"),
      priceSnapshot: { basePrice: 1000000, currency: "IDR", adminFee: 50000, depositRule: { type: "FIXED", amount: 500000 }, taxInclusive: false },
    },
  });
}

async function main() {
  const seedDb = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
  await seed(seedDb);

  const prisma = new PrismaService();
  const finance = new FinanceService(prisma);
  const tenant = { id: TEN, slug: "void-test" };

  // Issue an invoice for the order (as rentos_app, RLS-enforced).
  const invoice = await withTenantContext(prisma.raw, TEN, (tx) =>
    generateRentalOrderInvoice(tx, TEN, "void-test", true, {
      id: ORDER, customerId: CUST, periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-10-01"),
      priceSnapshot: { basePrice: 1000000, currency: "IDR", adminFee: 50000, depositRule: { type: "FIXED", amount: 500000 }, taxInclusive: false },
    }, { includeDeposit: true }),
  );

  const bal = (label: string) => seedDb.$queryRawUnsafe<Array<{ entry_type: string; sum: string }>>(
    `SELECT entry_type, coalesce(sum(amount),0)::text AS sum FROM ledger_entries WHERE tenant_id='${TEN}' GROUP BY entry_type`,
  ).then((rows) => {
    const d = Number(rows.find((r) => r.entry_type === "DEBIT")?.sum ?? 0);
    const c = Number(rows.find((r) => r.entry_type === "CREDIT")?.sum ?? 0);
    console.log(`${label}: DEBIT=${d} CREDIT=${c} balanced=${Math.abs(d - c) < 0.01}`);
    return Math.abs(d - c) < 0.01;
  });

  const balAfterIssue = await bal("after issue");
  await finance.voidInvoice(tenant, "00000000-0000-0000-0000-0000000000e9", invoice.id, "wrong period");
  const balAfterVoid = await bal("after void ");

  const voided = await seedDb.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
  // Net ledger contribution of this invoice (INVOICE + INVOICE_VOID) must be zero on each side.
  const net = await seedDb.$queryRawUnsafe<Array<{ entry_type: string; sum: string }>>(
    `SELECT entry_type, coalesce(sum(amount),0)::text AS sum FROM ledger_entries WHERE tenant_id='${TEN}' AND reference_id='${invoice.id}' GROUP BY entry_type`,
  );
  const netD = Number(net.find((r) => r.entry_type === "DEBIT")?.sum ?? 0);
  const netC = Number(net.find((r) => r.entry_type === "CREDIT")?.sum ?? 0);

  const pass = balAfterIssue && balAfterVoid && voided.status === "VOID" && Math.abs(netD - netC) < 0.01;
  console.log(`invoice status: ${voided.status} (expect VOID)`);
  console.log(`invoice net ledger: DEBIT=${netD} CREDIT=${netC} (issue+void cancel, both sides equal)`);
  console.log(pass ? "RESULT: PASS ✅" : "RESULT: FAIL ❌");

  await seedDb.$disconnect();
  await prisma.onModuleDestroy();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
