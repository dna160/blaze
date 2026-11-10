import type { Prisma, PrismaClient } from "../../generated/client/index.js";
import { raiseCounter, resolveNumbering, counterScope, zonedYearMonth } from "../document-number.js";
import { withTenantContext } from "../tenant-context.js";

import { parseCsv } from "./csv.js";

/**
 * PRD go-live §10 — migrate a branch's live book from the legacy system
 * (Booqable) into RentOS.
 *
 * Inputs (templates in prisma/data/kebon-jeruk/):
 *   migration-customers.csv     one row per customer
 *   migration-rentals.csv       one row per ACTIVE unit rental
 *   migration-open-invoices.csv invoices still unpaid at cut-over
 *
 * Contract:
 *   - DRY RUN by default; `apply` only when the dry run has zero errors.
 *   - Refuses to run at all unless the organization's messaging is paused, so
 *     nothing can reach a customer while their data is half-imported.
 *   - Idempotent: keyed by legacy customer number, booking number and invoice
 *     number; re-running updates and never duplicates.
 *   - Customers keep their legacy number; contracts and invoices keep their
 *     legacy numbers; counters move above the highest imported.
 *   - KYC = VERIFIED_LEGACY (not asked to redo KYC, distinguishable).
 *   - Rentals become ACTIVE indefinite monthly leases on their unit (OCCUPIED),
 *     anchored on the day after paid_through, with `paidThrough` set so the
 *     recurring job bills the NEXT cycle and never a paid one. No back-invoicing.
 *   - The deposit is recorded HELD at the amount actually held.
 *   - Ledger: opening balances only — Dr AR / Cr OPENING_BALANCE for open
 *     invoices, Dr OPENING_BALANCE / Cr DEPOSIT_LIABILITY for deposits. Never
 *     revenue.
 *
 * Runs as whatever client it is given; every tenant-table write goes through
 * withTenantContext, so it is correct under the RLS app role too.
 */

export interface LegacyInput {
  customersCsv: string;
  rentalsCsv: string;
  openInvoicesCsv: string;
  /** Reads a signed contract PDF named in migration-rentals.csv; null when missing. */
  readFile?: (relativePath: string) => Promise<Buffer | null>;
  /** Stores a signed contract PDF; returns its storage key. Without it, PDFs are not attached. */
  storeFile?: (key: string, buffer: Buffer, contentType: string) => Promise<string>;
  /**
   * The legacy system's highest contract / invoice running numbers overall
   * (not just the active ones in these files) — from the Booqable export.
   * New RentOS numbers continue above max(file, these).
   */
  minContractSeq?: number;
  minInvoiceSeq?: number;
}

export interface Finding {
  file: "customers" | "rentals" | "open-invoices";
  line: number;
  key: string;
  level: "error" | "warning";
  message: string;
}

export interface LegacyPlan {
  tenantId: string;
  messagingPaused: boolean;
  findings: Finding[];
  counts: {
    customers: { create: number; update: number };
    rentals: { create: number; update: number };
    openInvoices: { create: number; update: number };
  };
  totals: { activeRentals: number; arOutstanding: number; depositsHeld: number; monthlyRent: number };
  maxLegacy: { customerNumber: number; contractSeq: number; invoiceSeq: number };
  canApply: boolean;
}

interface CustomerRow {
  line: number;
  number: number;
  type: "INDIVIDUAL" | "BUSINESS";
  fullName: string;
  companyName: string | null;
  phone: string;
  email: string | null;
  address: string | null;
  ktp: string | null;
  npwp: string | null;
  nib: string | null;
  pphWithheld: boolean | null;
  notes: string | null;
}

interface RentalRow {
  line: number;
  bookingNumber: string;
  contractNumber: string;
  customerNumber: number;
  unitCode: string;
  typeSlug: string | null;
  start: Date;
  periodEnd: Date;
  monthlyPrice: number;
  depositHeld: number;
  paidThrough: Date;
  status: string;
  pdf: string | null;
  notes: string | null;
}

interface InvoiceRow {
  line: number;
  number: string;
  bookingNumber: string;
  invoiceDate: Date;
  dueDate: Date;
  periodStart: Date | null;
  periodEnd: Date | null;
  amount: number;
  paid: number;
  status: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function date(v: string | undefined): Date | null {
  const s = (v ?? "").trim();
  if (!DATE.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function num(v: string | undefined): number | null {
  const s = (v ?? "").trim().replace(/[.\s](?=\d{3}(\D|$))/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** +62 E.164 from the common Indonesian spellings (0812…, 62812…, +62 812-…). */
export function normalizeIdPhone(raw: string | undefined): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  const e164 = digits.startsWith("0") ? `62${digits.slice(1)}` : digits;
  return e164.length >= 10 && e164.length <= 15 ? `+${e164}` : null;
}

/**
 * "5-2026-36-39" -> 39: the running counter is the last segment of the legacy
 * {month}-{year}-{customer}-{seq} format. Anything else — a placeholder like
 * "BQ-337", or a per-unit suffix like "10-2026-44-237/STORAGE-9" (which still
 * reads 237) — never moves the counter by its trailing digits.
 */
export function legacySequence(number: string): number | null {
  const m = /^#?\d{1,2}-\d{4}-\d+-(\d+)(?:\D.*)?$/.exec(number.trim());
  return m ? Number(m[1]) : null;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

function parse(input: LegacyInput, findings: Finding[]) {
  const customers: CustomerRow[] = [];
  for (const [i, r] of parseCsv(input.customersCsv).entries()) {
    const line = i + 2;
    const key = r.legacy_customer_number ?? "";
    const err = (message: string) => findings.push({ file: "customers", line, key, level: "error", message });
    const n = Number(key);
    if (!Number.isInteger(n) || n <= 0) err("legacy_customer_number must be a positive whole number");
    const type = (r.customer_type ?? "INDIVIDUAL").trim().toUpperCase();
    if (type !== "INDIVIDUAL" && type !== "BUSINESS") err("customer_type must be INDIVIDUAL or BUSINESS");
    const phone = normalizeIdPhone(r.phone_e164);
    if (!phone) err(r.phone_e164 ? `phone "${r.phone_e164}" is not a usable number` : "missing phone");
    const fullName = (r.full_name ?? "").trim();
    if (!fullName) err("full_name is empty");
    if (type === "BUSINESS" && !(r.company_name ?? "").trim()) err("company_name is required for a BUSINESS customer");
    const pph = (r.pph_withheld ?? "").trim().toLowerCase();
    const address = [r.address_line, r.city, r.postal_code].map((s) => (s ?? "").trim()).filter(Boolean).join(", ") || null;
    customers.push({
      line,
      number: n,
      type: type === "BUSINESS" ? "BUSINESS" : "INDIVIDUAL",
      fullName,
      companyName: (r.company_name ?? "").trim() || null,
      phone: phone ?? "",
      email: (r.email ?? "").trim().toLowerCase() || null,
      address,
      ktp: (r.ktp_number ?? "").trim() || null,
      npwp: (r.npwp ?? "").trim() || null,
      nib: (r.nib ?? "").trim() || null,
      pphWithheld: pph === "true" || pph === "yes" || pph === "ya" ? true : pph === "false" || pph === "no" || pph === "tidak" ? false : null,
      notes: (r.notes ?? "").trim() || null,
    });
  }

  const rentals: RentalRow[] = [];
  for (const [i, r] of parseCsv(input.rentalsCsv).entries()) {
    const line = i + 2;
    const key = r.legacy_booking_number ?? "";
    const err = (message: string) => findings.push({ file: "rentals", line, key, level: "error", message });
    if (!key.trim()) err("legacy_booking_number is empty");
    if (!(r.legacy_contract_number ?? "").trim()) err("legacy_contract_number is empty");
    const cust = Number(r.legacy_customer_number);
    if (!Number.isInteger(cust)) err("legacy_customer_number must be a whole number");
    if (!(r.unit_code ?? "").trim()) err("unit_code is empty");
    const start = date(r.start_date);
    const periodEnd = date(r.current_period_end);
    const paidThrough = date(r.paid_through);
    if (!start) err("start_date must be YYYY-MM-DD");
    if (!periodEnd) err("current_period_end must be YYYY-MM-DD");
    if (!paidThrough) err("paid_through must be YYYY-MM-DD");
    if (start && periodEnd && periodEnd <= start) err("current_period_end must be after start_date");
    const price = num(r.monthly_price_idr);
    const deposit = num(r.deposit_held_idr);
    if (price === null || price <= 0) err("monthly_price_idr must be a positive amount");
    if (deposit === null || deposit < 0) err("deposit_held_idr must be an amount (0 if none)");
    const status = (r.status ?? "ACTIVE").trim().toUpperCase();
    if (status !== "ACTIVE") err(`status "${status}" — only ACTIVE rentals are migrated; leave ended rentals out`);
    rentals.push({
      line,
      bookingNumber: key.trim().replace(/^#/, ""),
      contractNumber: (r.legacy_contract_number ?? "").trim().replace(/^#/, ""),
      customerNumber: cust,
      unitCode: (r.unit_code ?? "").trim(),
      typeSlug: (r.unit_type_slug ?? "").trim() || null,
      start: start ?? new Date(0),
      periodEnd: periodEnd ?? new Date(0),
      monthlyPrice: price ?? 0,
      depositHeld: deposit ?? 0,
      paidThrough: paidThrough ?? new Date(0),
      status,
      pdf: (r.signed_contract_pdf ?? "").trim() || null,
      notes: (r.notes ?? "").trim() || null,
    });
  }

  const invoices: InvoiceRow[] = [];
  for (const [i, r] of parseCsv(input.openInvoicesCsv).entries()) {
    const line = i + 2;
    const key = (r.legacy_invoice_number ?? "").trim().replace(/^#/, "");
    const err = (message: string) => findings.push({ file: "open-invoices", line, key, level: "error", message });
    if (!key) err("legacy_invoice_number is empty");
    const invoiceDate = date(r.invoice_date);
    const dueDate = date(r.due_date);
    if (!invoiceDate) err("invoice_date must be YYYY-MM-DD");
    if (!dueDate) err("due_date must be YYYY-MM-DD");
    const amount = num(r.amount_idr);
    const paid = num(r.amount_paid_idr) ?? 0;
    if (amount === null || amount <= 0) err("amount_idr must be a positive amount");
    if (amount !== null && (paid < 0 || paid >= amount)) err("amount_paid_idr must be below amount_idr (fully paid invoices are not open — leave them out)");
    invoices.push({
      line,
      number: key,
      bookingNumber: (r.legacy_booking_number ?? "").trim().replace(/^#/, ""),
      invoiceDate: invoiceDate ?? new Date(0),
      dueDate: dueDate ?? new Date(0),
      periodStart: date(r.period_start),
      periodEnd: date(r.period_end),
      amount: amount ?? 0,
      paid,
      status: (r.status ?? "ISSUED").trim().toUpperCase(),
    });
  }
  return { customers, rentals, invoices };
}

export async function planLegacyImport(prisma: PrismaClient, tenantId: string, input: LegacyInput) {
  const findings: Finding[] = [];
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { id: true, organization: { select: { messagingPaused: true } } },
  });
  const { customers, rentals, invoices } = parse(input, findings);

  const db = await withTenantContext(prisma, tenantId, async (tx) => ({
    customers: await tx.customer.findMany({ select: { id: true, customerNumber: true, phone: true } }),
    assets: await tx.asset.findMany({ select: { id: true, code: true, status: true, assetType: { select: { slug: true } } } }),
    bookings: await tx.booking.findMany({
      where: { status: { in: ["ACTIVE", "APPROVED", "PENDING_APPROVAL", "NOTICE_GIVEN", "RENEWING", "SUSPENDED"] } },
      select: { id: true, assetId: true, legacyBookingNumber: true, status: true },
    }),
    legacyBookings: await tx.booking.findMany({ where: { legacyBookingNumber: { not: null } }, select: { legacyBookingNumber: true } }),
    invoices: await tx.invoice.findMany({ where: { invoiceNumber: { in: invoices.map((i) => i.number) } }, select: { invoiceNumber: true } }),
  }));

  const add = (f: Finding) => findings.push(f);

  // Customers: duplicates in file, phone clashes with a different existing customer.
  const custByNumber = new Map<number, CustomerRow>();
  const phones = new Map<string, number>();
  for (const c of customers) {
    if (custByNumber.has(c.number)) add({ file: "customers", line: c.line, key: String(c.number), level: "error", message: `duplicate legacy_customer_number (also line ${custByNumber.get(c.number)!.line})` });
    custByNumber.set(c.number, c);
    if (c.phone) {
      if (phones.has(c.phone)) add({ file: "customers", line: c.line, key: String(c.number), level: "error", message: `phone ${c.phone} is also on customer ${phones.get(c.phone)} — one phone per customer` });
      phones.set(c.phone, c.number);
      const owner = db.customers.find((x) => x.phone === c.phone);
      if (owner && owner.customerNumber !== c.number) {
        add({ file: "customers", line: c.line, key: String(c.number), level: "error", message: `phone ${c.phone} already belongs to RentOS customer #${owner.customerNumber}` });
      }
    }
    const taken = db.customers.find((x) => x.customerNumber === c.number && x.phone !== c.phone);
    if (taken) add({ file: "customers", line: c.line, key: String(c.number), level: "error", message: `customer number ${c.number} is already used by a different RentOS customer (${taken.phone})` });
  }

  // Rentals.
  const rentalByBooking = new Map<string, RentalRow>();
  const unitsInFile = new Map<string, RentalRow>();
  for (const r of rentals) {
    const f = (level: Finding["level"], message: string) => add({ file: "rentals", line: r.line, key: r.bookingNumber, level, message });
    if (rentalByBooking.has(r.bookingNumber)) f("error", `duplicate legacy_booking_number (also line ${rentalByBooking.get(r.bookingNumber)!.line})`);
    rentalByBooking.set(r.bookingNumber, r);
    if (!custByNumber.has(r.customerNumber) && !db.customers.some((c) => c.customerNumber === r.customerNumber)) f("error", `customer ${r.customerNumber} is not in migration-customers.csv or RentOS`);
    const asset = db.assets.find((a) => a.code === r.unitCode);
    if (!asset) f("error", `unknown unit code ${r.unitCode} — import units first`);
    else {
      if (r.typeSlug && asset.assetType.slug !== r.typeSlug) f("error", `${r.unitCode} is ${asset.assetType.slug} in RentOS but ${r.typeSlug} in the file`);
      const holder = db.bookings.find((b) => b.assetId === asset.id && b.legacyBookingNumber !== r.bookingNumber);
      if (holder) f("error", `unit ${r.unitCode} is already occupied in RentOS (booking ${holder.legacyBookingNumber ?? holder.id.slice(0, 8)}, ${holder.status})`);
    }
    const other = unitsInFile.get(r.unitCode);
    if (other && other.start < r.periodEnd && r.start < other.periodEnd) f("error", `overlapping dates with booking ${other.bookingNumber} on the same unit ${r.unitCode}`);
    unitsInFile.set(r.unitCode, r);
    if (r.depositHeld !== r.monthlyPrice) {
      f("warning", `deposit mismatch: held ${r.depositHeld} vs 1x rent ${r.monthlyPrice} — the held amount is kept as-is`);
    }
    if (r.paidThrough < r.start) f("error", "paid_through is before start_date");
    const monthAgo = addDays(new Date(), -31);
    if (r.paidThrough < monthAgo && !invoices.some((i) => i.bookingNumber === r.bookingNumber)) {
      f("warning", `paid_through ${r.paidThrough.toISOString().slice(0, 10)} is over a month ago and no open invoice covers the gap — those months will not be billed`);
    }
    if (r.pdf && input.readFile && !(await input.readFile(r.pdf))) f("warning", `signed contract PDF "${r.pdf}" not found — the contract imports without it`);
  }

  // Open invoices.
  const invSeen = new Map<string, number>();
  for (const inv of invoices) {
    const f = (level: Finding["level"], message: string) => add({ file: "open-invoices", line: inv.line, key: inv.number, level, message });
    if (invSeen.has(inv.number)) f("error", `duplicate legacy_invoice_number (also line ${invSeen.get(inv.number)})`);
    invSeen.set(inv.number, inv.line);
    if (!rentalByBooking.has(inv.bookingNumber)) f("error", `booking ${inv.bookingNumber} is not in migration-rentals.csv`);
    if (inv.paid > 0) f("warning", `partly paid (${inv.paid} of ${inv.amount}) — imported as the outstanding ${inv.amount - inv.paid}`);
  }

  const existingCust = new Set(db.customers.map((c) => c.customerNumber));
  const existingBooking = new Set(db.legacyBookings.map((b) => b.legacyBookingNumber));
  const existingInv = new Set(db.invoices.map((i) => i.invoiceNumber));
  const plan: LegacyPlan = {
    tenantId,
    messagingPaused: tenant.organization.messagingPaused,
    findings,
    counts: {
      customers: { create: customers.filter((c) => !existingCust.has(c.number)).length, update: customers.filter((c) => existingCust.has(c.number)).length },
      rentals: { create: rentals.filter((r) => !existingBooking.has(r.bookingNumber)).length, update: rentals.filter((r) => existingBooking.has(r.bookingNumber)).length },
      openInvoices: { create: invoices.filter((i) => !existingInv.has(i.number)).length, update: invoices.filter((i) => existingInv.has(i.number)).length },
    },
    totals: {
      activeRentals: rentals.length,
      arOutstanding: invoices.reduce((a, i) => a + (i.amount - i.paid), 0),
      depositsHeld: rentals.reduce((a, r) => a + r.depositHeld, 0),
      monthlyRent: rentals.reduce((a, r) => a + r.monthlyPrice, 0),
    },
    maxLegacy: {
      customerNumber: Math.max(0, ...customers.map((c) => c.number).filter(Number.isFinite)),
      contractSeq: Math.max(input.minContractSeq ?? 0, ...rentals.map((r) => legacySequence(r.contractNumber) ?? 0)),
      invoiceSeq: Math.max(input.minInvoiceSeq ?? 0, ...invoices.map((i) => legacySequence(i.number) ?? 0)),
    },
    canApply: false,
  };
  if (!plan.messagingPaused) {
    findings.unshift({ file: "customers", line: 0, key: "-", level: "error", message: "Messaging is not paused. Pause it (Settings → Messaging) before migrating, so no customer is messaged mid-import." });
  }
  plan.canApply = !findings.some((f) => f.level === "error") && customers.length + rentals.length + invoices.length > 0;
  return { plan, parsed: { customers, rentals, invoices } };
}

async function ledgerOnce(
  tx: Prisma.TransactionClient,
  tenantId: string,
  referenceId: string,
  description: string,
  entries: Array<{ account: "ACCOUNTS_RECEIVABLE" | "DEPOSIT_LIABILITY" | "OPENING_BALANCE"; entryType: "DEBIT" | "CREDIT"; amount: number }>,
) {
  const exists = await tx.ledgerEntry.findFirst({ where: { referenceType: "LEGACY_IMPORT", referenceId } });
  if (exists) return;
  for (const e of entries) {
    await tx.ledgerEntry.create({
      data: { tenantId, account: e.account, entryType: e.entryType, amount: e.amount.toFixed(2), referenceType: "LEGACY_IMPORT", referenceId, description },
    });
  }
}

export async function applyLegacyImport(prisma: PrismaClient, tenantId: string, input: LegacyInput) {
  const { plan, parsed } = await planLegacyImport(prisma, tenantId, input);
  if (!plan.canApply) return { plan, applied: false as const };

  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { organizationId: true, numbering: true, timezone: true, featureFlags: true },
  });
  const terms = await prisma.contractTerms.findFirst({ where: { organizationId: tenant.organizationId }, orderBy: { version: "desc" }, select: { version: true } });
  const location = await withTenantContext(prisma, tenantId, (tx) => tx.location.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } }));

  // 1. Customers — keyed by legacy customer number.
  const customerIds = new Map<number, string>();
  for (const c of parsed.customers) {
    const data = {
      type: c.type,
      fullName: c.fullName,
      companyName: c.companyName,
      phone: c.phone,
      email: c.email,
      address: c.address,
      taxId: c.npwp,
      nib: c.nib,
      pphWithheld: c.pphWithheld,
      kycStatus: "VERIFIED_LEGACY" as const,
      notes: [c.notes, c.ktp ? `KTP ${c.ktp}` : null, "Imported from Booqable"].filter(Boolean).join(" · "),
    };
    const row = await withTenantContext(prisma, tenantId, (tx) =>
      tx.customer.upsert({
        where: { tenantId_customerNumber: { tenantId, customerNumber: c.number } },
        create: { tenantId, customerNumber: c.number, ...data },
        update: data,
      }),
    );
    customerIds.set(c.number, row.id);
  }

  // 2. Rentals — keyed by legacy booking number.
  const bookingIds = new Map<string, string>();
  for (const r of parsed.rentals) {
    const customerId =
      customerIds.get(r.customerNumber) ??
      (await withTenantContext(prisma, tenantId, (tx) => tx.customer.findUniqueOrThrow({ where: { tenantId_customerNumber: { tenantId, customerNumber: r.customerNumber } } }))).id;
    const pdfKey = r.pdf && input.readFile && input.storeFile ? await (async () => {
      const buf = await input.readFile!(r.pdf!);
      return buf ? input.storeFile!(`contracts/${tenantId}/legacy/${r.contractNumber.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`, buf, "application/pdf") : null;
    })() : null;

    const bookingId = await withTenantContext(prisma, tenantId, async (tx) => {
      const asset = await tx.asset.findUniqueOrThrow({ where: { tenantId_code: { tenantId, code: r.unitCode } }, include: { assetType: true } });
      const pricing = (asset.assetType.pricing ?? {}) as Record<string, unknown>;
      const nextStart = addDays(r.paidThrough, 1);
      const data = {
        customerId,
        assetTypeId: asset.assetTypeId,
        assetId: asset.id,
        locationId: asset.locationId ?? location?.id ?? null,
        bookingModel: "RECURRING_LEASE" as const,
        rateTier: "MONTHLY" as const,
        status: "ACTIVE" as const,
        startDate: r.start,
        endDate: null,
        termMonths: null,
        anchorDay: nextStart.getUTCDate(),
        paidThrough: r.paidThrough,
        priceSnapshot: { ...pricing, basePrice: r.monthlyPrice, importedFrom: "booqable", legacyCurrentPeriodEnd: r.periodEnd.toISOString().slice(0, 10) } as Prisma.InputJsonValue,
      };
      const existing = await tx.booking.findUnique({ where: { tenantId_legacyBookingNumber: { tenantId, legacyBookingNumber: r.bookingNumber } } });
      const booking = existing
        ? await tx.booking.update({ where: { id: existing.id }, data })
        : await tx.booking.create({ data: { tenantId, legacyBookingNumber: r.bookingNumber, ...data } });
      if (!existing) {
        await tx.bookingEvent.create({
          data: { tenantId, bookingId: booking.id, fromStatus: null, toStatus: "ACTIVE", actorType: "SYSTEM", reason: `Imported from Booqable (booking #${r.bookingNumber})`, metadata: { legacyContractNumber: r.contractNumber } },
        });
      }
      await tx.asset.update({ where: { id: asset.id }, data: { status: "OCCUPIED", statusReason: `Legacy booking #${r.bookingNumber}` } });

      const contractData = {
        templateVersion: "legacy-booqable",
        termsVersion: terms?.version ?? null,
        esignProvider: "LEGACY",
        esignStatus: "SIGNED",
        signedAt: r.start,
        ...(pdfKey ? { documentUrl: pdfKey } : {}),
      };
      const contract = await tx.contract.findUnique({ where: { tenantId_contractNumber: { tenantId, contractNumber: r.contractNumber } } });
      if (contract) await tx.contract.update({ where: { id: contract.id }, data: { bookingId: booking.id, ...contractData } });
      else await tx.contract.create({ data: { tenantId, bookingId: booking.id, contractNumber: r.contractNumber, ...contractData } });

      const deposit = await tx.deposit.findFirst({ where: { bookingId: booking.id } });
      if (deposit) await tx.deposit.update({ where: { id: deposit.id }, data: { amount: r.depositHeld.toFixed(2) } });
      else if (r.depositHeld > 0) await tx.deposit.create({ data: { tenantId, bookingId: booking.id, amount: r.depositHeld.toFixed(2), status: "HELD" } });

      if (r.depositHeld > 0) {
        await ledgerOnce(tx, tenantId, booking.id, `Opening balance: deposit held, Booqable booking #${r.bookingNumber}`, [
          { account: "OPENING_BALANCE", entryType: "DEBIT", amount: r.depositHeld },
          { account: "DEPOSIT_LIABILITY", entryType: "CREDIT", amount: r.depositHeld },
        ]);
      }
      return booking.id;
    });
    bookingIds.set(r.bookingNumber, bookingId);
  }

  // 3. Open invoices — keyed by legacy invoice number.
  const today = new Date();
  for (const inv of parsed.invoices) {
    const bookingId = bookingIds.get(inv.bookingNumber)!;
    const rental = parsed.rentals.find((r) => r.bookingNumber === inv.bookingNumber)!;
    const customerId = customerIds.get(rental.customerNumber) ?? (await withTenantContext(prisma, tenantId, (tx) => tx.booking.findUniqueOrThrow({ where: { id: bookingId } }))).customerId;
    const outstanding = inv.amount - inv.paid;
    await withTenantContext(prisma, tenantId, async (tx) => {
      const description =
        inv.paid > 0
          ? `Outstanding balance, Booqable invoice #${inv.number} (total ${inv.amount}, paid ${inv.paid})`
          : `Sewa / Rent ${rental.unitCode}${inv.periodStart && inv.periodEnd ? ` ${inv.periodStart.toISOString().slice(0, 10)} – ${inv.periodEnd.toISOString().slice(0, 10)}` : ""}`;
      const data = {
        bookingId,
        customerId,
        status: (inv.dueDate < today ? "OVERDUE" : "ISSUED") as "OVERDUE" | "ISSUED",
        subtotal: outstanding.toFixed(2),
        taxAmount: "0",
        totalAmount: outstanding.toFixed(2),
        issueDate: inv.invoiceDate,
        dueDate: inv.dueDate,
        periodStart: inv.periodStart,
        periodEnd: inv.periodEnd,
      };
      const existing = await tx.invoice.findUnique({ where: { tenantId_invoiceNumber: { tenantId, invoiceNumber: inv.number } } });
      let invoiceId: string;
      if (existing) {
        await tx.invoiceLine.deleteMany({ where: { invoiceId: existing.id } });
        await tx.invoice.update({ where: { id: existing.id }, data: { ...data, lines: { create: [{ tenantId, description, unitPrice: outstanding.toFixed(2), amount: outstanding.toFixed(2), lineType: "RENT" }] } } });
        invoiceId = existing.id;
      } else {
        const created = await tx.invoice.create({
          data: { tenantId, invoiceNumber: inv.number, ...data, lines: { create: [{ tenantId, description, unitPrice: outstanding.toFixed(2), amount: outstanding.toFixed(2), lineType: "RENT" }] } },
        });
        invoiceId = created.id;
      }
      await ledgerOnce(tx, tenantId, invoiceId, `Opening balance: Booqable invoice #${inv.number}`, [
        { account: "ACCOUNTS_RECEIVABLE", entryType: "DEBIT", amount: outstanding },
        { account: "OPENING_BALANCE", entryType: "CREDIT", amount: outstanding },
      ]);
    });
  }

  // 4. Counters continue above the highest legacy number (§6.2).
  const cfg = resolveNumbering(tenant.numbering);
  const scope = counterScope(cfg.seqReset, zonedYearMonth(new Date(), tenant.timezone || "Asia/Jakarta"));
  await withTenantContext(prisma, tenantId, async (tx) => {
    if (plan.maxLegacy.contractSeq > 0) await raiseCounter(tx, tenantId, "CONTRACT", scope, plan.maxLegacy.contractSeq);
    if (plan.maxLegacy.invoiceSeq > 0) await raiseCounter(tx, tenantId, "INVOICE", scope, plan.maxLegacy.invoiceSeq);
  });
  // The customer counter is raised by the customers_assign_number trigger.

  return { plan, applied: true as const };
}
