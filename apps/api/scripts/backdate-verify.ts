/**
 * BUILD-SPEC #34 evidence — backdating a rental order voids the superseded
 * invoice (no pile-up), reissues for the shifted period, and keeps the ledger
 * balanced. Run: DATABASE_URL=... DATABASE_URL_APP=... JWT_SECRET=x tsx apps/api/scripts/backdate-verify.ts
 */
import { PrismaClient, generateRentalOrderInvoice, withTenantContext } from "@rentos/database";

import { FinanceService } from "../src/finance/finance.service.js";
import { PrismaService } from "../src/prisma/prisma.service.js";

const ORG = "00000000-0000-0000-0000-0000000000c0";
const TEN = "00000000-0000-0000-0000-0000000000c1";
const AT = "00000000-0000-0000-0000-0000000000c2";
const CUST = "00000000-0000-0000-0000-0000000000c3";
const ORDER = "00000000-0000-0000-0000-0000000000c4";
const PRICE = { basePrice: 1000000, currency: "IDR", adminFee: 50000, depositRule: { type: "FIXED", amount: 500000 }, taxInclusive: false };

async function seed(db: PrismaClient) {
  for (const t of ["invoice_lines", "ledger_entries", "invoices", "rental_orders", "customers", "asset_types", "tenants"]) {
    await db.$executeRawUnsafe(`DELETE FROM ${t} WHERE ${t === "tenants" ? "id" : "tenant_id"} = '${TEN}'`);
  }
  await db.$executeRawUnsafe(`DELETE FROM organizations WHERE id = '${ORG}'`);
  await db.organization.create({ data: { id: ORG, slug: "bd-org", name: "BD Org" } });
  await db.tenant.create({ data: { id: TEN, organizationId: ORG, slug: "bd-test", name: "BD Test", isPkp: true } });
  await db.assetType.create({ data: { id: AT, tenantId: TEN, name: "U", slug: "u", bookingModel: "RECURRING_LEASE", pricing: PRICE } });
  await db.customer.create({ data: { id: CUST, tenantId: TEN, phone: "+62700", type: "INDIVIDUAL" } });
  await db.rentalOrder.create({
    data: { id: ORDER, tenantId: TEN, customerId: CUST, assetTypeId: AT, status: "AWAITING_PAYMENT", periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-10-01"), priceSnapshot: PRICE },
  });
}

async function main() {
  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
  await seed(db);
  const prisma = new PrismaService();
  const finance = new FinanceService(prisma);

  const original = await withTenantContext(prisma.raw, TEN, (tx) =>
    generateRentalOrderInvoice(tx, TEN, "bd-test", true, { id: ORDER, customerId: CUST, periodStart: new Date("2026-09-01"), periodEnd: new Date("2026-10-01"), priceSnapshot: PRICE }, { includeDeposit: false }),
  );

  const result = await finance.backdateRentalOrder({ id: TEN, slug: "bd-test", isPkp: true }, "00000000-0000-0000-0000-0000000000c9", ORDER, new Date("2026-08-15"));

  const orig = await db.invoice.findUniqueOrThrow({ where: { id: original.id } });
  const repl = await db.invoice.findUniqueOrThrow({ where: { id: result.replacementInvoiceId } });
  const order = await db.rentalOrder.findUniqueOrThrow({ where: { id: ORDER } });
  const led = await db.$queryRawUnsafe<Array<{ entry_type: string; sum: string }>>(
    `SELECT entry_type, coalesce(sum(amount),0)::text AS sum FROM ledger_entries WHERE tenant_id='${TEN}' GROUP BY entry_type`,
  );
  const d = Number(led.find((r) => r.entry_type === "DEBIT")?.sum ?? 0);
  const c = Number(led.find((r) => r.entry_type === "CREDIT")?.sum ?? 0);

  const pass =
    orig.status === "VOID" && orig.supersededByInvoiceId === repl.id &&
    repl.status === "ISSUED" && repl.periodStart?.toISOString().slice(0, 10) === "2026-08-15" &&
    order.periodStart.toISOString().slice(0, 10) === "2026-08-15" && Math.abs(d - c) < 0.01;

  console.log("=== #34 backdate ===");
  console.log(`original invoice: ${orig.status} (expect VOID), supersededBy=${orig.supersededByInvoiceId === repl.id}`);
  console.log(`replacement invoice: ${repl.status} periodStart=${repl.periodStart?.toISOString().slice(0, 10)} (expect ISSUED / 2026-08-15)`);
  console.log(`order periodStart=${order.periodStart.toISOString().slice(0, 10)} periodEnd=${order.periodEnd.toISOString().slice(0, 10)}`);
  console.log(`ledger: DEBIT=${d} CREDIT=${c} balanced=${Math.abs(d - c) < 0.01}`);
  console.log(pass ? "RESULT: PASS ✅" : "RESULT: FAIL ❌");

  await db.$disconnect();
  await prisma.onModuleDestroy();
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
