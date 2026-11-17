/**
 * One-off: wipe ONE branch's client data, keep its inventory (owner,
 * 2026-11-17: "wipe the data from kebon jeruk, keep the inventory … wipe the
 * client data/invoice for now. I'll pull the data via the API later on").
 * Run from the API's release step:
 *
 *   ONE_OFF_WIPE=dry    ONE_OFF_WIPE_TENANT=<slug>  — do it in a transaction, print it, roll back
 *   ONE_OFF_WIPE=apply  ONE_OFF_WIPE_TENANT=<slug>  — the same, committed
 *
 * Deleted, for that tenant only: customers and everything hanging off them —
 * rentals (bookings, rental orders), contracts, invoices, payments, credit
 * notes, deposits, KYC documents, access tokens, waitlist entries, swap
 * requests — plus the ledger, the notification / message history, webhook
 * deliveries and the legacy (Booqable) archive.
 *
 * Kept: units, unit types, the location, staff accounts and roles, branch and
 * messaging settings, contract terms, API keys, document-number counters (so
 * no contract or invoice number is ever issued twice) and the audit log.
 *
 * Units held by a rental go back to AVAILABLE. Unit types are UNPUBLISHED, so
 * the public storefront cannot sell a unit that is physically occupied while
 * the book is empty; re-publish in Catalog Setup once the data is back.
 *
 * Runs as the owner role (DATABASE_URL), like the seed. Nothing here can be
 * undone: the dry run is the check.
 */
import { PrismaClient, type Prisma } from "../generated/client/index.js";

const MODE = process.env.ONE_OFF_WIPE;
const SLUG = process.env.ONE_OFF_WIPE_TENANT;

class Rollback extends Error {}

async function wipe(tx: Prisma.TransactionClient, log: (s: string) => void) {
  if (!SLUG) throw new Error("ONE_OFF_WIPE_TENANT is not set — name the branch to wipe.");
  const tenant = await tx.tenant.findUnique({ where: { slug: SLUG } });
  if (!tenant) throw new Error(`No tenant "${SLUG}".`);
  const t = { tenantId: tenant.id };
  log(`Branch: ${tenant.name} (${tenant.slug}).`);

  const others = await tx.customer.count({ where: { tenantId: { not: tenant.id } } });
  const inventory = async () => ({
    units: await tx.asset.count({ where: t }),
    unitTypes: await tx.assetType.count({ where: t }),
    locations: await tx.location.count({ where: t }),
    staff: await tx.user.count({ where: t }),
  });
  const before = await inventory();

  // Children first; every statement is scoped to this tenant.
  const steps: Array<[string, () => Promise<{ count: number }>]> = [
    ["ledger entries", () => tx.ledgerEntry.deleteMany({ where: t })],
    ["notifications / messages", () => tx.notification.deleteMany({ where: t })],
    ["webhook deliveries", () => tx.tenantWebhookDelivery.deleteMany({ where: t })],
    ["payment webhook events", () => tx.webhookEvent.deleteMany({ where: t })],
    ["credit notes", () => tx.creditNote.deleteMany({ where: t })],
    ["payments", () => tx.payment.deleteMany({ where: t })],
    ["invoice lines", () => tx.invoiceLine.deleteMany({ where: t })],
    ["invoices", () => tx.invoice.deleteMany({ where: t })],
    ["deposits", () => tx.deposit.deleteMany({ where: t })],
    ["swap requests", () => tx.swapRequest.deleteMany({ where: t })],
    ["contracts", () => tx.contract.deleteMany({ where: t })],
    ["order acceptances", () => tx.orderAcceptance.deleteMany({ where: t })],
    ["rental order events", () => tx.rentalOrderEvent.deleteMany({ where: t })],
    ["waitlist entries", () => tx.waitlistEntry.deleteMany({ where: t })],
    ["rental orders", () => tx.rentalOrder.deleteMany({ where: t })],
    ["master agreements", () => tx.masterAgreement.deleteMany({ where: t })],
    ["booking events", () => tx.bookingEvent.deleteMany({ where: t })],
    ["rentals (bookings)", () => tx.booking.deleteMany({ where: t })],
    ["KYC documents", () => tx.kycDocument.deleteMany({ where: t })],
    ["customer access tokens", () => tx.customerAccessToken.deleteMany({ where: t })],
    ["customer phones", () => tx.customerPhone.deleteMany({ where: t })],
    ["customers", () => tx.customer.deleteMany({ where: t })],
    ["legacy (Booqable) records", () => tx.legacyRecord.deleteMany({ where: t })],
  ];
  for (const [label, run] of steps) log(`  deleted ${String((await run()).count).padStart(5)}  ${label}`);

  // Per-number auto-reply state is the organization's; clear it only when this
  // branch is the whole organization (another branch's customers keep theirs).
  const siblings = await tx.tenant.count({ where: { organizationId: tenant.organizationId, id: { not: tenant.id } } });
  if (siblings === 0) {
    const s = await tx.messagingContactState.deleteMany({ where: { organizationId: tenant.organizationId } });
    log(`  deleted ${String(s.count).padStart(5)}  messaging contact states`);
  }

  const freed = await tx.asset.updateMany({ where: { ...t, status: { in: ["OCCUPIED", "RESERVED"] } }, data: { status: "AVAILABLE", statusReason: null } });
  log(`Units set back to AVAILABLE: ${freed.count}.`);
  const published = await tx.assetType.findMany({ where: { ...t, isPublished: true }, select: { name: true }, orderBy: { name: "asc" } });
  await tx.assetType.updateMany({ where: { ...t, isPublished: true }, data: { isPublished: false } });
  log(`Unit types unpublished (re-publish in Catalog Setup): ${published.map((p) => p.name).join(", ") || "-"}.`);

  await tx.auditLog.create({
    data: { tenantId: tenant.id, action: "BRANCH_CLIENT_DATA_WIPED", entityType: "Tenant", entityId: tenant.id, metadata: { by: "one-off release step", mode: MODE } },
  });

  const after = await inventory();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error(`Inventory changed: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  if ((await tx.customer.count({ where: { tenantId: { not: tenant.id } } })) !== others) throw new Error("Another branch's customers changed.");
  log(`Kept: ${after.units} units, ${after.unitTypes} unit types, ${after.locations} location(s), ${after.staff} staff accounts. Other branches untouched (${others} customers).`);
}

async function main() {
  if (MODE !== "dry" && MODE !== "apply") throw new Error('ONE_OFF_WIPE must be "dry" or "apply".');
  const prisma = new PrismaClient();
  const log = (s: string) => console.log(`[wipe:${MODE}] ${s}`);
  try {
    await prisma.$transaction(
      async (tx) => {
        await wipe(tx, log);
        if (MODE === "dry") throw new Rollback();
      },
      { timeout: 300_000, maxWait: 20_000 },
    );
    console.log(`[wipe:${MODE}] committed.`);
  } catch (e) {
    if (e instanceof Rollback) console.log("[wipe:dry] rolled back — nothing was changed.");
    else throw e;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`[wipe:${MODE}] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
