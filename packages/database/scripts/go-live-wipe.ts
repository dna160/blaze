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
 * ONE_OFF_WIPE_RESET_COUNTERS=1 (PRD go-live 2 §7.1) — ALSO put the number
 * counters back, for the wipe that ends the client's test period. Test
 * contracts and invoices consumed real sequence numbers; without this the
 * first real contract after go-live would carry a gap. With it, the branch's
 * contract / invoice / credit-note counters and the organization's customer
 * counter return to the "legacy maximum", so real numbering continues from
 * Booqable.
 *
 * What "legacy maximum" means here. After a wipe RentOS holds no legacy
 * number at all — the maxima live in Booqable and in the import files. So the
 * reset goes to the FLOOR, and the final import, which must follow at once,
 * raises the counters to the true legacy maxima itself (it already does: the
 * contract and invoice counters to the highest number in the files or
 * `minContractSeq` / `minInvoiceSeq`, the customer counter through the
 * customers_assign_number trigger). The floor is:
 *   - document counters: 0 — every contract and invoice of the branch was just
 *     deleted, so nothing left can collide;
 *   - customer counter: the highest customer number still in the organization
 *     (another branch's customers keep theirs), 0 when there is none.
 * If something might be issued between this wipe and the import, pin the
 * maxima explicitly instead — the reset then never goes below them:
 *   ONE_OFF_WIPE_MIN_CONTRACT_SEQ, ONE_OFF_WIPE_MIN_INVOICE_SEQ,
 *   ONE_OFF_WIPE_MIN_CUSTOMER_NUMBER   (Booqable's highest numbers).
 * Run it only at the END of testing, immediately before the final import;
 * never for the wipe that STARTS a test period (keeping the counters there is
 * harmless, and resetting them is what this run is for).
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
const RESET_COUNTERS = ["1", "true", "yes", "on"].includes((process.env.ONE_OFF_WIPE_RESET_COUNTERS ?? "").trim().toLowerCase());

/** An optional non-negative whole number from the environment; anything else is a refusal, not a silent 0. */
function floorFromEnv(name: string): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a whole number of 0 or more (got "${raw}").`);
  return n;
}

/**
 * PRD go-live 2 §7.1 — put the number counters back to the legacy maximum (see
 * the header for what that means after a wipe). Runs inside the wipe's
 * transaction, after the deletes, so a dry run shows it and rolls it back.
 */
async function resetCounters(tx: Prisma.TransactionClient, tenant: { id: string; organizationId: string }, log: (s: string) => void) {
  const floors = {
    CONTRACT: floorFromEnv("ONE_OFF_WIPE_MIN_CONTRACT_SEQ"),
    INVOICE: floorFromEnv("ONE_OFF_WIPE_MIN_INVOICE_SEQ"),
    CREDIT_NOTE: 0,
  } as const;
  const customerFloor = floorFromEnv("ONE_OFF_WIPE_MIN_CUSTOMER_NUMBER");

  // The reset is only safe on an empty book: a surviving contract or invoice
  // would be renumbered over. The wipe above guarantees it; check anyway.
  const leftovers = (await tx.contract.count({ where: { tenantId: tenant.id } })) + (await tx.invoice.count({ where: { tenantId: tenant.id } }));
  if (leftovers > 0) throw new Error(`Counters not reset: ${leftovers} contract(s)/invoice(s) still exist in this branch.`);

  const before = await tx.documentNumberCounter.findMany({ where: { tenantId: tenant.id }, orderBy: [{ kind: "asc" }, { scope: "asc" }] });
  const show = (rows: Array<{ kind: string; scope: string; value: number }>) => rows.map((r) => `${r.kind}[${r.scope}]=${r.value}`).join(", ") || "none";
  log(`Counters before: ${show(before)}.`);

  // Every scope of every kind goes back: a yearly/monthly scope from the test
  // period must not survive either. A pinned floor is written to the scopes
  // that exist (the next number continues above it); with no floor the rows
  // are removed, which is the state of a branch that has never issued anything.
  for (const kind of ["CONTRACT", "INVOICE", "CREDIT_NOTE"] as const) {
    const floor = floors[kind];
    if (floor === 0) {
      await tx.documentNumberCounter.deleteMany({ where: { tenantId: tenant.id, kind } });
    } else {
      const scopes = before.filter((r) => r.kind === kind).map((r) => r.scope);
      await tx.documentNumberCounter.deleteMany({ where: { tenantId: tenant.id, kind } });
      // "all" is the scope of a never-resetting sequence (City Storage's); keep any other scope that was in use too.
      for (const scope of new Set(["all", ...scopes])) {
        await tx.documentNumberCounter.create({ data: { tenantId: tenant.id, kind, scope, value: floor } });
      }
    }
  }
  const after = await tx.documentNumberCounter.findMany({ where: { tenantId: tenant.id }, orderBy: [{ kind: "asc" }, { scope: "asc" }] });
  log(`Counters after:  ${show(after)}  (next contract no. ${floors.CONTRACT + 1}, next invoice no. ${floors.INVOICE + 1}).`);

  // The customer counter is the ORGANIZATION's: never below a number another branch still uses.
  const orgTenants = await tx.tenant.findMany({ where: { organizationId: tenant.organizationId }, select: { id: true } });
  const highest = await tx.customer.aggregate({ where: { tenantId: { in: orgTenants.map((t) => t.id) } }, _max: { customerNumber: true } });
  const surviving = highest._max.customerNumber ?? 0;
  const target = Math.max(customerFloor, surviving);
  const current = await tx.customerNumberCounter.findUnique({ where: { organizationId: tenant.organizationId } });
  await tx.customerNumberCounter.upsert({
    where: { organizationId: tenant.organizationId },
    create: { organizationId: tenant.organizationId, value: target },
    update: { value: target },
  });
  log(
    `Customer counter: ${current?.value ?? "none"} -> ${target} (next customer no. ${target + 1}` +
      `${surviving > 0 ? `; highest number still used in the organization: ${surviving}` : ""}).`,
  );
  log("Counters reset. Run the final Booqable import NOW: it raises them to Booqable's highest numbers.");
}

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

  if (RESET_COUNTERS) await resetCounters(tx, tenant, log);
  else log("Number counters kept (ONE_OFF_WIPE_RESET_COUNTERS is not set): no contract or invoice number is reused.");

  await tx.auditLog.create({
    data: {
      tenantId: tenant.id,
      action: "BRANCH_CLIENT_DATA_WIPED",
      entityType: "Tenant",
      entityId: tenant.id,
      metadata: { by: "one-off release step", mode: MODE, countersReset: RESET_COUNTERS },
    },
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
