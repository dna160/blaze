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
 *   {M} {MM}   month, plain / 2-digit       11 / 11
 *   {YYYY}     year                         2026
 *   {CUST}     Customer.customerNumber      36
 *   {SEQ}      the counter, plain           40
 *   {SEQ:n}    the counter, zero-padded     {SEQ:6} -> 000040
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

/** PRD go-live §6.2 — the City Storage format, e.g. KBJ-11-2026-36-40. */
export const CITY_STORAGE_NUMBERING: Required<NumberingConfig> = {
  contract: "{BRANCH}-{M}-{YYYY}-{CUST}-{SEQ}",
  invoice: "{BRANCH}-{M}-{YYYY}-{CUST}-{SEQ}",
  creditNote: "{BRANCH}-CN-{M}-{YYYY}-{CUST}-{SEQ}",
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
}

/** Pure — exported for tests and for the console's "preview" of a format. */
export function formatDocumentNumber(format: string, ctx: FormatContext): string {
  return format.replace(/\{([A-Z]+)(?::(\d+))?\}/g, (whole, token: string, pad: string | undefined) => {
    switch (token) {
      case "BRANCH":
        return ctx.branchCode ?? ctx.slug.toUpperCase();
      case "SLUG":
        return ctx.slug.toUpperCase();
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
  params: { tenantId: string; kind: DocumentKindValue; customerId?: string | null; at?: Date },
): Promise<string> {
  // `tenants` is outside RLS (bootstrap registry); `customers` is read in the
  // caller's tenant context, which is the same tenant.
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: params.tenantId },
    select: { slug: true, branchCode: true, timezone: true, numbering: true },
  });
  const cfg = resolveNumbering(tenant.numbering);
  const format = cfg[KIND_KEY[params.kind]];
  const ym = zonedYearMonth(params.at ?? new Date(), tenant.timezone || "Asia/Jakarta");

  let customerNumber: number | null = null;
  if (format.includes("{CUST}") && params.customerId) {
    const customer = await tx.customer.findUnique({ where: { id: params.customerId }, select: { customerNumber: true } });
    customerNumber = customer?.customerNumber ?? null;
  }

  const seq = await takeCounter(tx, params.tenantId, params.kind, counterScope(cfg.seqReset, ym));
  return formatDocumentNumber(format, { branchCode: tenant.branchCode, slug: tenant.slug, ...ym, customerNumber, seq });
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
): Promise<{ contractNumber: string; termsVersion: number | null }> {
  const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { organizationId: true } });
  const terms = await tx.contractTerms.findFirst({
    where: { organizationId: tenant.organizationId },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  const contractNumber = await nextDocumentNumber(tx, { tenantId, kind: "CONTRACT", customerId });
  return { contractNumber, termsVersion: terms?.version ?? null };
}
