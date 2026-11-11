/**
 * One-off repair of the live database after the Kebon Jeruk go-live import
 * (owner, 2026-11-11). Run from the API's release step:
 *
 *   ONE_OFF_REPAIR=dry    — do everything in a transaction, print it, roll back
 *   ONE_OFF_REPAIR=apply  — the same, committed
 *
 * 1. Gudang Aman's location. The data-pack bootstrap updated location
 *    ...0101 by id; on this database that id belonged to Gudang Aman, so its
 *    location was renamed "City Storage Kebon Jeruk". Restore its name/address.
 * 2. City Storage's location. The branch had none, so every imported unit and
 *    rental shows "no location". Create it from the data pack and attach every
 *    City Storage unit and booking that has no location.
 * 3. Demo staff. Seed accounts (…@….test) share a password that is written in
 *    the repository; with real customers in the branch they are SUSPENDED.
 * 4. Demo customer data. The seed's demo customer (Budi Santoso,
 *    +6281100000001), with his rentals, bookings, contracts, invoices, payments,
 *    deposits, notifications and their ledger entries, is deleted. Customers
 *    imported from Booqable are never touched.
 * 5. Demo units A-01..A-03, B-14, B-15 and the two demo unit types are deleted
 *    once nothing references them (archived otherwise).
 *
 * Runs as the owner role (DATABASE_URL), like the seed.
 */
import { PrismaClient, type Prisma } from "../generated/client/index.js";

import { readBranchProfile } from "../prisma/city-storage.js";

const MODE = process.env.ONE_OFF_REPAIR;
const CITY = "city-storage-kebon-jeruk";
const GUDANG = "gudang-aman";
const GUDANG_LOCATION = { id: "00000000-0000-0000-0000-000000000101", name: "Gudang Aman — Kelapa Gading", address: "Jl. Boulevard Raya, Kelapa Gading, Jakarta Utara" };
const DEMO_PHONES = ["+6281100000001"];
const DEMO_UNIT_CODES = ["A-01", "A-02", "A-03", "B-14", "B-15"];
const DEMO_TYPE_SLUGS = ["unit-1-5x2", "unit-3x3"];

class Rollback extends Error {}

async function repair(tx: Prisma.TransactionClient, log: (s: string) => void) {
  const city = await tx.tenant.findUnique({ where: { slug: CITY } });
  if (!city) throw new Error(`No tenant ${CITY}.`);
  const gudang = await tx.tenant.findUnique({ where: { slug: GUDANG } });

  // 1. Gudang Aman's location.
  const loc = await tx.location.findUnique({ where: { id: GUDANG_LOCATION.id } });
  if (loc && gudang && loc.tenantId === gudang.id && loc.name !== GUDANG_LOCATION.name) {
    await tx.location.update({ where: { id: loc.id }, data: { name: GUDANG_LOCATION.name, address: GUDANG_LOCATION.address } });
    log(`1. Gudang Aman location restored ("${loc.name}" -> "${GUDANG_LOCATION.name}").`);
  } else log("1. Gudang Aman location: nothing to restore.");

  // 2. City Storage's own location.
  let cityLoc = await tx.location.findFirst({ where: { tenantId: city.id }, orderBy: { createdAt: "asc" } });
  if (!cityLoc) {
    const p = readBranchProfile().tenant;
    cityLoc = await tx.location.create({
      data: {
        tenantId: city.id,
        name: p.location.name,
        address: p.location.addressLines.join(", "),
        timezone: p.timezone,
        latitude: p.location.latitude ?? -6.1944,
        longitude: p.location.longitude ?? 106.7692,
      },
    });
    log(`2. City Storage location created: ${cityLoc.name}.`);
  } else log(`2. City Storage location exists: ${cityLoc.name}.`);
  const assets = await tx.asset.updateMany({ where: { tenantId: city.id, locationId: null }, data: { locationId: cityLoc.id } });
  const bookings = await tx.booking.updateMany({ where: { tenantId: city.id, locationId: null }, data: { locationId: cityLoc.id } });
  log(`   attached ${assets.count} units and ${bookings.count} bookings to it.`);

  // 3. Demo staff accounts.
  const demoUsers = await tx.user.findMany({ where: { tenantId: city.id, email: { endsWith: ".test" }, status: { not: "SUSPENDED" } }, select: { id: true, email: true } });
  if (demoUsers.length) await tx.user.updateMany({ where: { id: { in: demoUsers.map((u) => u.id) } }, data: { status: "SUSPENDED" } });
  log(`3. Demo staff suspended (${demoUsers.length}): ${demoUsers.map((u) => u.email).join(", ") || "-"}`);

  // 4. The demo customer and everything hanging off him.
  const customers = await tx.customer.findMany({
    where: {
      tenantId: city.id,
      AND: [
        { OR: [{ phone: { in: DEMO_PHONES } }, { email: { endsWith: ".test" } }] },
        // Never a Booqable import. (notes IS NULL must be spelled out: NOT LIKE on NULL is NULL, not true.)
        { OR: [{ notes: null }, { NOT: { notes: { contains: "Booqable" } } }] },
      ],
    },
    select: { id: true, fullName: true, phone: true },
  });
  const cIds = customers.map((c) => c.id);
  const invoices = await tx.invoice.findMany({ where: { customerId: { in: cIds } }, select: { id: true } });
  const invIds = invoices.map((i) => i.id);
  const payments = await tx.payment.findMany({ where: { invoiceId: { in: invIds } }, select: { id: true } });
  const creditNotes = await tx.creditNote.findMany({ where: { invoiceId: { in: invIds } }, select: { id: true } });
  const bks = await tx.booking.findMany({ where: { customerId: { in: cIds } }, select: { id: true } });
  const deposits = await tx.deposit.findMany({ where: { bookingId: { in: bks.map((b) => b.id) } }, select: { id: true } });
  const orders = await tx.rentalOrder.findMany({ where: { customerId: { in: cIds } }, select: { id: true } });
  const refs = [...invIds, ...payments.map((p) => p.id), ...creditNotes.map((c) => c.id), ...bks.map((b) => b.id), ...deposits.map((d) => d.id)];
  const ledger = await tx.ledgerEntry.deleteMany({ where: { tenantId: city.id, referenceId: { in: refs } } });
  const notes = await tx.notification.deleteMany({ where: { tenantId: city.id, customerId: { in: cIds } } });
  await tx.waitlistEntry.updateMany({ where: { firedRentalOrderId: { in: orders.map((o) => o.id) } }, data: { firedRentalOrderId: null } });
  await tx.customer.deleteMany({ where: { id: { in: cIds } } }); // cascades: invoices, payments, bookings, deposits, rental orders, contracts, agreements, KYC
  log(
    `4. Demo customers deleted (${customers.length}): ${customers.map((c) => `${c.fullName} ${c.phone}`).join(", ") || "-"} — ` +
      `${invIds.length} invoices, ${payments.length} payments, ${bks.length} bookings, ${orders.length} rental orders, ${ledger.count} ledger rows, ${notes.count} notifications.`,
  );

  // 5. Demo units and demo unit types.
  const demoUnits = await tx.asset.findMany({
    where: { tenantId: city.id, code: { in: DEMO_UNIT_CODES } },
    select: { id: true, code: true, _count: { select: { bookings: true, rentalOrders: true, swapRequestTargets: true } } },
  });
  const freeUnits = demoUnits.filter((u) => u._count.bookings + u._count.rentalOrders + u._count.swapRequestTargets === 0);
  await tx.asset.deleteMany({ where: { id: { in: freeUnits.map((u) => u.id) } } });
  const keptUnits = demoUnits.filter((u) => !freeUnits.includes(u)).map((u) => u.code);
  log(`5. Demo units deleted: ${freeUnits.map((u) => u.code).join(", ") || "-"}${keptUnits.length ? `; still referenced, kept: ${keptUnits.join(", ")}` : ""}.`);
  for (const slug of DEMO_TYPE_SLUGS) {
    const t = await tx.assetType.findUnique({
      where: { tenantId_slug: { tenantId: city.id, slug } },
      include: { _count: { select: { bookings: true, rentalOrders: true, waitlistEntries: true, swapRequests: true, assets: true } } },
    });
    if (!t) continue;
    const c = t._count;
    if (c.bookings + c.rentalOrders + c.waitlistEntries + c.swapRequests + c.assets === 0) {
      await tx.assetType.delete({ where: { id: t.id } });
      log(`   demo unit type deleted: ${t.name}.`);
    } else {
      await tx.assetType.update({ where: { id: t.id }, data: { archivedAt: new Date(), isPublished: false } });
      log(`   demo unit type archived (still referenced): ${t.name} ${JSON.stringify(c)}.`);
    }
  }
}

async function main() {
  if (MODE !== "dry" && MODE !== "apply") throw new Error('ONE_OFF_REPAIR must be "dry" or "apply".');
  const prisma = new PrismaClient();
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    console.log(`[repair:${MODE}] ${s}`);
  };
  try {
    await prisma.$transaction(
      async (tx) => {
        await repair(tx, log);
        if (MODE === "dry") throw new Rollback();
      },
      { timeout: 120_000, maxWait: 20_000 },
    );
    console.log(`[repair:${MODE}] committed.`);
  } catch (e) {
    if (e instanceof Rollback) console.log("[repair:dry] rolled back — nothing was changed.");
    else throw e;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`[repair:${MODE}] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
