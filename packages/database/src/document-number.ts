import type { Prisma } from "../generated/client/index.js";

/**
 * Document numbers — contracts, invoices and credit notes (PRD go-live §6).
 *
 * Contracts and invoices are separate sequences: one contract has many
 * invoices, and a unit added later gets its own contract. Each tenant picks a
 * format in `Tenant.numbering`; the counter row is chosen by the format's
 * reset policy, so "never" keeps one running sequence and "monthly" restarts
 * every month.
 *
 * Tokens:
 *   {BRANCH}   Tenant.branchCode            KBJ
 *   {SLUG}     Tenant.slug, upper-cased     CITY-STORAGE-KEBON-JERUK
 *   {D} {DD}   day, plain / 2-digit         9 / 09
 *   {M} {MM}   month, plain / 2-digit       11 / 11
 *   {YYYY}     year                         2026
 *   {CUST}     Customer.customerNumber      36
 *   {SEQ}      the counter, plain           40
 *   {SEQ:n}    the counter, zero-padded     {SEQ:6} -> 000040
 *   {CONTRACT} the sequence number of the contract an invoice belongs to
 *              (its {SEQ} when it was numbered), {CONTRACT:n} zero-padded;
 *              0 when the invoice has no contract
 *
 * Month and year are read in the TENANT's timezone, never the server's: an
 * invoice issued at 06:00 WIB on the 1st is 23:00 UTC the previous day, and
 * must not carry the previous month.
 *
 * The counter is a single INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING,
 * so Postgres's row lock on the conflicting key serializes concurrent callers
 * (the Session 24 discipline InvoiceNumberCounter introduced).
 */

export type DocumentKindValue = "CONTRACT" | "INVOICE" | "CREDIT_NOTE";
export type SeqReset = "never" | "yearly" | "monthly";

export interface NumberingConfig {
  contract?: string;
  invoice?: string;
  creditNote?: string;
  seqReset?: SeqReset;
}

/**
 * For a tenant that has configured nothing: the pre-go-live invoice format,
 * byte for byte (`SLUG/2026/11/000001`, monthly), and a contract number in
 * the same family. Kebon Jeruk sets its own (see the seed).
 */
export const LEGACY_NUMBERING: Required<NumberingConfig> = {
  contract: "{SLUG}/CTR/{YYYY}/{MM}/{SEQ:6}",
  invoice: "{SLUG}/{YYYY}/{MM}/{SEQ:6}",
  creditNote: "{SLUG}/CN/{YYYY}/{MM}/{SEQ:6}",
  seqReset: "monthly",
};

/**
 * City Storage's format (owner, 2026-11-10):
 *   contract  customer no - DDMMYYYY - contract no - branch code   36-10112026-40-KBJ
 *   invoice   customer no - DDMMYYYY - contract no - invoice no    36-10112026-40-123
 * Contract and invoice numbers are separate running counters that never reset.
 */
export const CITY_STORAGE_NUMBERING: Required<NumberingConfig> = {
  contract: "{CUST}-{DD}{MM}{YYYY}-{SEQ}-{BRANCH}",
  invoice: "{CUST}-{DD}{MM}{YYYY}-{CONTRACT}-{SEQ}",
  creditNote: "{CUST}-{DD}{MM}{YYYY}-{CONTRACT}-CN{SEQ}",
  seqReset: "never",
};

const KIND_KEY: Record<DocumentKindValue, keyof Omit<NumberingConfig, "seqReset">> = {
  CONTRACT: "contract",
  INVOICE: "invoice",
  CREDIT_NOTE: "creditNote",
};

/** A tenant's effective config: its own keys over the legacy defaults. */
export function resolveNumbering(raw: unknown): Required<NumberingConfig> {
  const cfg = (raw && typeof raw === "object" ? raw : {}) as NumberingConfig;
  const seqReset = cfg.seqReset === "never" || cfg.seqReset === "yearly" || cfg.seqReset === "monthly" ? cfg.seqReset : undefined;
  return {
    contract: cfg.contract || LEGACY_NUMBERING.contract,
    invoice: cfg.invoice || LEGACY_NUMBERING.invoice,
    creditNote: cfg.creditNote || LEGACY_NUMBERING.creditNote,
    // A tenant that set formats but no reset policy gets "never": a running
    // counter is what every format without {MM}/{YYYY} implicitly assumes.
    seqReset: seqReset ?? (cfg.invoice || cfg.contract ? "never" : LEGACY_NUMBERING.seqReset),
  };
}

/** Year and month of `at` as seen in `timeZone` (IANA, e.g. Asia/Jakarta). */
export function zonedYearMonth(at: Date, timeZone: string): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric" }).formatToParts(at);
  const year = Number(parts.find((p) => p.type === "year")?.value);
  const month = Number(parts.find((p) => p.type === "month")?.value);
  return { year, month };
}

/** Year, month and day of `at` as seen in `timeZone`. */
export function zonedDate(at: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: n("year"), month: n("month"), day: n("day") };
}

export function counterScope(reset: SeqReset, ym: { year: number; month: number }): string {
  if (reset === "monthly") return `${ym.year}-${String(ym.month).padStart(2, "0")}`;
  if (reset === "yearly") return String(ym.year);
  return "all";
}

export interface FormatContext {
  branchCode: string | null;
  slug: string;
  year: number;
  month: number;
  customerNumber: number | null;
  seq: number;
  /** Day of month in the tenant's timezone ({D}/{DD}); defaults to 1 when unknown. */
  day?: number;
  /** The related contract's sequence number ({CONTRACT}); 0 when there is none. */
  contractSeq?: number | null;
}

/** Pure — exported for tests and for the console's "preview" of a format. */
export function formatDocumentNumber(format: string, ctx: FormatContext): string {
  return format.replace(/\{([A-Z]+)(?::(\d+))?\}/g, (whole, token: string, pad: string | undefined) => {
    switch (token) {
      case "BRANCH":
        return ctx.branchCode ?? ctx.slug.toUpperCase();
      case "SLUG":
        return ctx.slug.toUpperCase();
      case "D":
        return String(ctx.day ?? 1);
      case "DD":
        return String(ctx.day ?? 1).padStart(2, "0");
      case "CONTRACT":
        return pad ? String(ctx.contractSeq ?? 0).padStart(Number(pad), "0") : String(ctx.contractSeq ?? 0);
      case "M":
        return String(ctx.month);
      case "MM":
        return String(ctx.month).padStart(2, "0");
      case "YYYY":
        return String(ctx.year);
      case "CUST":
        return String(ctx.customerNumber ?? 0);
      case "SEQ":
        return pad ? String(ctx.seq).padStart(Number(pad), "0") : String(ctx.seq);
      default:
        return whole;
    }
  });
}

/** Atomically take the next value of one counter. */
export async function takeCounter(tx: Prisma.TransactionClient, tenantId: string, kind: DocumentKindValue, scope: string): Promise<number> {
  const rows = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO document_number_counters (id, tenant_id, kind, scope, value)
    VALUES (gen_random_uuid(), ${tenantId}::uuid, ${kind}::"DocumentKind", ${scope}, 1)
    ON CONFLICT (tenant_id, kind, scope)
    DO UPDATE SET value = document_number_counters.value + 1
    RETURNING value
  `;
  return Number(rows[0]!.value);
}

/**
 * Raise a counter to at least `atLeast` (never lowers it). The legacy importer
 * calls this so new numbers continue above the highest imported one.
 */
export async function raiseCounter(
  tx: Prisma.TransactionClient,
  tenantId: string,
  kind: DocumentKindValue,
  scope: string,
  atLeast: number,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO document_number_counters (id, tenant_id, kind, scope, value)
    VALUES (gen_random_uuid(), ${tenantId}::uuid, ${kind}::"DocumentKind", ${scope}, ${atLeast})
    ON CONFLICT (tenant_id, kind, scope)
    DO UPDATE SET value = GREATEST(document_number_counters.value, EXCLUDED.value)
  `;
}

/**
 * The next number of `kind` for this tenant. `customerId` fills {CUST}; `at`
 * is the issue moment (defaults to now) whose tenant-local month/year fill the
 * date tokens and pick the counter scope.
 */
export async function nextDocumentNumber(
  tx: Prisma.TransactionClient,
  params: DocumentNumberParams,
): Promise<string> {
  return (await nextDocumentNumberWithSeq(tx, params)).number;
}

export interface DocumentNumberParams {
  tenantId: string;
  kind: DocumentKindValue;
  customerId?: string | null;
  at?: Date;
  /** Fills {CONTRACT} on invoices — the contract's own sequence number. */
  contractSeq?: number | null;
}

/** As nextDocumentNumber, also returning the counter value it took (a contract stores it for {CONTRACT}). */
export async function nextDocumentNumberWithSeq(
  tx: Prisma.TransactionClient,
  params: DocumentNumberParams,
): Promise<{ number: string; seq: number }> {
  // `tenants` is outside RLS (bootstrap registry); `customers` is read in the
  // caller's tenant context, which is the same tenant.
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: params.tenantId },
    select: { slug: true, branchCode: true, timezone: true, numbering: true },
  });
  const cfg = resolveNumbering(tenant.numbering);
  const format = cfg[KIND_KEY[params.kind]];
  const date = zonedDate(params.at ?? new Date(), tenant.timezone || "Asia/Jakarta");
  const ym = { year: date.year, month: date.month };

  let customerNumber: number | null = null;
  if (format.includes("{CUST}") && params.customerId) {
    const customer = await tx.customer.findUnique({ where: { id: params.customerId }, select: { customerNumber: true } });
    customerNumber = customer?.customerNumber ?? null;
  }

  const seq = await takeCounter(tx, params.tenantId, params.kind, counterScope(cfg.seqReset, ym));
  const number = formatDocumentNumber(format, {
    branchCode: tenant.branchCode,
    slug: tenant.slug,
    ...ym,
    day: date.day,
    customerNumber,
    seq,
    contractSeq: params.contractSeq ?? null,
  });
  return { number, seq };
}

/**
 * The sequence number of the contract an invoice belongs to (its booking's or
 * rental order's latest contract), for {CONTRACT}. A contract imported from the
 * legacy system has no stored sequence; its legacy running number is used.
 */
export async function contractSeqFor(
  tx: Prisma.TransactionClient,
  owner: { bookingId?: string | null; rentalOrderId?: string | null },
): Promise<number | null> {
  if (!owner.bookingId && !owner.rentalOrderId) return null;
  const contract = await tx.contract.findFirst({
    where: owner.rentalOrderId ? { rentalOrderId: owner.rentalOrderId } : { bookingId: owner.bookingId! },
    orderBy: { createdAt: "desc" },
    select: { contractSeq: true, contractNumber: true },
  });
  if (!contract) return null;
  if (contract.contractSeq !== null) return contract.contractSeq;
  const m = /^#?\d{1,2}-\d{4}-\d+-(\d+)/.exec(contract.contractNumber ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * What every new Contract row carries (PRD go-live §6.2, §7.1): its number
 * from the tenant's CONTRACT sequence, and the organization's current T&C
 * version, so the contract re-renders with exactly the terms it was issued
 * under. `contract_terms` sits outside RLS (organization-level).
 */
export async function newContractFields(
  tx: Prisma.TransactionClient,
  tenantId: string,
  customerId: string | null,
): Promise<{ contractNumber: string; contractSeq: number; termsVersion: number | null }> {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { organizationId: true } });
  const terms = await tx.contractTerms.findFirst({
    where: { organizationId: tenant.organizationId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const { number: contractNumber, seq: contractSeq } = await nextDocumentNumberWithSeq(tx, { tenantId, kind: "CONTRACT", customerId });
  return { contractNumber, contractSeq, termsVersion: terms?.version ?? null };
}
