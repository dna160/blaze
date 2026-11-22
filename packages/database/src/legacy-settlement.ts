import type { Prisma } from "../generated/client/index.js";

/**
 * PRD go-live 2 §7.3 — "Dibayar di Booqable / Paid in Booqable".
 *
 * Booqable's payments live only in the read-only legacy archive
 * (`legacy_records`). An invoice imported from Booqable and settled there
 * afterwards is VOIDed by the re-sync with a fixed reason, and staff then saw
 * "no payments yet" on it. These helpers find the legacy evidence for an
 * invoice or a customer so the console can say where the money went.
 *
 * Matching (the archive is keyed the way `scripts/booqable/to_archive.py`
 * writes it):
 *  - a legacy INVOICE record carries the invoice's own number (`number`) and
 *    its order number in `data.orderNumber`;
 *  - a legacy PAYMENT record carries its order number in `number` (and
 *    `data.orderNumber`);
 *  - an imported rental's `legacyBookingNumber` is "<first order>/<unit>".
 * Nothing here writes; nothing feeds the ledger.
 */

/** The reason the legacy re-sync stamps on an imported invoice it voids (imports/legacy.ts). */
export const LEGACY_SETTLED_VOID_REASON_PREFIX = "Settled in Booqable";

const PAID_STATUSES = new Set(["paid", "overpaid"]);

export interface LegacyPaymentRef {
  /** legacy_records.id — the console links to /legacy?record=<id>. */
  recordId: string;
  orderNumber: string | null;
  occurredAt: string | null;
  /** Rupiah; negative for a refund. */
  amount: number | null;
  status: string | null;
  title: string | null;
}

export interface LegacyInvoiceSettlement {
  /** True when Booqable says this invoice is paid, or the re-sync voided it as settled there. */
  settledInLegacy: boolean;
  /** Why we think so, for the chip's tooltip. */
  basis: "VOIDED_AS_SETTLED" | "LEGACY_INVOICE_PAID" | "LEGACY_PAYMENTS" | null;
  /** The legacy INVOICE record with this number, if archived. */
  invoiceRecordId: string | null;
  legacyStatus: string | null;
  orderNumber: string | null;
  /** Payments Booqable recorded on the same order. */
  payments: LegacyPaymentRef[];
}

function dataOf(data: Prisma.JsonValue): Record<string, unknown> {
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

function orderOf(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function toPaymentRef(r: { id: string; number: string | null; occurredAt: Date | null; amount: Prisma.Decimal | null; status: string | null; title: string | null; data: Prisma.JsonValue }): LegacyPaymentRef {
  return {
    recordId: r.id,
    orderNumber: orderOf(dataOf(r.data).orderNumber) ?? r.number,
    occurredAt: r.occurredAt?.toISOString() ?? null,
    amount: r.amount === null ? null : Number(r.amount.toString()),
    status: r.status,
    title: r.title,
  };
}

/**
 * Legacy settlement evidence for each of `invoices` (keyed by invoice id).
 * Invoices with no legacy trace at all are absent from the map. Runs inside a
 * tenant context (legacy_records is RLS-scoped).
 */
export async function legacySettlementForInvoices(
  tx: Prisma.TransactionClient,
  invoices: Array<{ id: string; invoiceNumber: string; status: string; voidReason: string | null; booking?: { legacyBookingNumber: string | null } | null }>,
): Promise<Map<string, LegacyInvoiceSettlement>> {
  const out = new Map<string, LegacyInvoiceSettlement>();
  if (invoices.length === 0) return out;

  const legacyInvoices = await tx.legacyRecord.findMany({
    where: { kind: "INVOICE", number: { in: invoices.map((i) => i.invoiceNumber) } },
    select: { id: true, number: true, status: true, data: true },
  });
  const invByNumber = new Map(legacyInvoices.map((r) => [r.number!, r]));

  // The order each invoice belongs to: from its archived record, else from the rental's legacy key.
  const orderFor = new Map<string, string>();
  for (const inv of invoices) {
    const rec = invByNumber.get(inv.invoiceNumber);
    const order = orderOf(rec ? dataOf(rec.data).orderNumber : null) ?? inv.booking?.legacyBookingNumber?.split("/")[0] ?? null;
    if (order) orderFor.set(inv.id, order);
  }
  const orders = [...new Set(orderFor.values())];
  const payments = orders.length
    ? await tx.legacyRecord.findMany({
        where: { kind: "PAYMENT", number: { in: orders } },
        select: { id: true, number: true, occurredAt: true, amount: true, status: true, title: true, data: true },
        orderBy: { occurredAt: "asc" },
      })
    : [];
  const paymentsByOrder = new Map<string, LegacyPaymentRef[]>();
  for (const p of payments) {
    const ref = toPaymentRef(p);
    const key = ref.orderNumber ?? p.number ?? "";
    paymentsByOrder.set(key, [...(paymentsByOrder.get(key) ?? []), ref]);
  }

  for (const inv of invoices) {
    const rec = invByNumber.get(inv.invoiceNumber) ?? null;
    const order = orderFor.get(inv.id) ?? null;
    const pays = order ? (paymentsByOrder.get(order) ?? []) : [];
    const voidedAsSettled = inv.status === "VOID" && (inv.voidReason ?? "").startsWith(LEGACY_SETTLED_VOID_REASON_PREFIX);
    const legacyPaid = rec ? PAID_STATUSES.has((rec.status ?? "").toLowerCase()) : false;
    if (!rec && pays.length === 0 && !voidedAsSettled) continue;
    out.set(inv.id, {
      settledInLegacy: voidedAsSettled || legacyPaid,
      basis: voidedAsSettled ? "VOIDED_AS_SETTLED" : legacyPaid ? "LEGACY_INVOICE_PAID" : pays.length ? "LEGACY_PAYMENTS" : null,
      invoiceRecordId: rec?.id ?? null,
      legacyStatus: rec?.status ?? null,
      orderNumber: order,
      payments: pays,
    });
  }
  return out;
}

export interface CustomerLegacyPayments {
  /** Booqable payments and refunds for this customer, newest first (at most `limit`). */
  payments: LegacyPaymentRef[];
  /** Net rupiah Booqable recorded as paid by this customer (refunds subtracted), over all records. */
  totalPaid: number;
  paymentCount: number;
  /** Imported rentals and how far Booqable had them paid. */
  rentals: Array<{ bookingId: string; legacyBookingNumber: string; unitCode: string | null; status: string; paidThrough: string | null }>;
}

/** The client page's "paid in Booqable" block. Runs inside a tenant context. */
export async function legacyPaymentsForCustomer(
  tx: Prisma.TransactionClient,
  customer: { id: string; customerNumber: number | null },
  limit = 20,
): Promise<CustomerLegacyPayments> {
  const where: Prisma.LegacyRecordWhereInput = {
    kind: "PAYMENT",
    OR: [{ customerId: customer.id }, ...(customer.customerNumber != null ? [{ customerNumber: customer.customerNumber }] : [])],
  };
  const [rows, agg, count, rentals] = await Promise.all([
    tx.legacyRecord.findMany({
      where,
      select: { id: true, number: true, occurredAt: true, amount: true, status: true, title: true, data: true },
      orderBy: { occurredAt: "desc" },
      take: limit,
    }),
    tx.legacyRecord.aggregate({ where: { ...where, NOT: { status: { in: ["failed", "canceled", "cancelled"] } } }, _sum: { amount: true } }),
    tx.legacyRecord.count({ where }),
    tx.booking.findMany({
      where: { customerId: customer.id, legacyBookingNumber: { not: null } },
      select: { id: true, legacyBookingNumber: true, status: true, paidThrough: true, asset: { select: { code: true } } },
      orderBy: { startDate: "asc" },
    }),
  ]);
  return {
    payments: rows.map(toPaymentRef),
    totalPaid: Number(agg._sum.amount?.toString() ?? 0),
    paymentCount: count,
    rentals: rentals.map((b) => ({
      bookingId: b.id,
      legacyBookingNumber: b.legacyBookingNumber!,
      unitCode: b.asset?.code ?? null,
      status: b.status,
      paidThrough: b.paidThrough ? b.paidThrough.toISOString().slice(0, 10) : null,
    })),
  };
}
