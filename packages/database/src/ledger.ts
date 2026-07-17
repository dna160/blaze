import type { LedgerAccount, LedgerEntryType, Prisma } from "../generated/client/index.js";

/**
 * Double-entry ledger writes (PRD Appendix A `ledger_entries`, §10
 * Reliability: "double-entry ledger balances checked nightly"). Accrual
 * basis: revenue is recognized at invoice ISSUE (debit AR, credit
 * Revenue/TaxPayable), not at payment — matching the schema's inclusion
 * of an ACCOUNTS_RECEIVABLE account, which would be pointless under pure
 * cash-basis accounting.
 *
 * Deposits never touch Revenue or AR — they are a liability from the
 * moment cash is received (PRD §7.2.4: "held as liability, not revenue").
 *
 * Lives in @rentos/database, not apps/api, for the same reason as
 * invoicing.ts: apps/worker generates recurring-cycle invoices directly
 * against this package, and those invoices need the same AR/Revenue
 * entries a console-approved invoice gets — one code path, not two that
 * could drift.
 */

async function recordEntry(
  tx: Prisma.TransactionClient,
  tenantId: string,
  account: LedgerAccount,
  entryType: LedgerEntryType,
  amount: string,
  referenceType: string,
  referenceId: string,
  description: string,
) {
  if (Number(amount) <= 0) return; // zero-amount entries (e.g. no tax for a non-PKP tenant) are simply omitted
  await tx.ledgerEntry.create({
    data: { tenantId, account, entryType, amount, currency: "IDR", referenceType, referenceId, description },
  });
}

/** Called at invoice issue (packages/database/src/invoicing.ts persistInvoice). */
export async function recordInvoiceIssuedEntries(
  tx: Prisma.TransactionClient,
  tenantId: string,
  invoiceId: string,
  invoiceNumber: string,
  revenueAmount: string,
  taxAmount: string,
) {
  const arAmount = (Number(revenueAmount) + Number(taxAmount)).toFixed(2);
  await recordEntry(tx, tenantId, "ACCOUNTS_RECEIVABLE", "DEBIT", arAmount, "INVOICE", invoiceId, `Invoice ${invoiceNumber} issued`);
  await recordEntry(tx, tenantId, "REVENUE", "CREDIT", revenueAmount, "INVOICE", invoiceId, `Invoice ${invoiceNumber} issued`);
  await recordEntry(tx, tenantId, "TAX_PAYABLE", "CREDIT", taxAmount, "INVOICE", invoiceId, `Invoice ${invoiceNumber} issued — PPN`);
}

/** Called when a payment closes an invoice's AR (apps/api PaymentsService.finalizePaidInvoice). */
export async function recordPaymentReceivedEntries(
  tx: Prisma.TransactionClient,
  tenantId: string,
  paymentId: string,
  invoiceId: string,
  revenuePortion: string,
) {
  await recordEntry(tx, tenantId, "CASH", "DEBIT", revenuePortion, "PAYMENT", paymentId, `Payment received for invoice ${invoiceId}`);
  await recordEntry(tx, tenantId, "ACCOUNTS_RECEIVABLE", "CREDIT", revenuePortion, "PAYMENT", paymentId, `Payment received for invoice ${invoiceId}`);
}

/** Called when a paid invoice includes a deposit line — the deposit never touched AR, it becomes a liability the moment cash lands. */
export async function recordDepositHeldEntries(
  tx: Prisma.TransactionClient,
  tenantId: string,
  depositId: string,
  amount: string,
) {
  await recordEntry(tx, tenantId, "CASH", "DEBIT", amount, "DEPOSIT", depositId, "Deposit collected");
  await recordEntry(tx, tenantId, "DEPOSIT_LIABILITY", "CREDIT", amount, "DEPOSIT", depositId, "Deposit collected");
}

/** Called on deposit refund approval (apps/api DepositsService). */
export async function recordDepositRefundedEntries(
  tx: Prisma.TransactionClient,
  tenantId: string,
  depositId: string,
  amount: string,
) {
  await recordEntry(tx, tenantId, "DEPOSIT_LIABILITY", "DEBIT", amount, "DEPOSIT", depositId, "Deposit refunded");
  await recordEntry(tx, tenantId, "CASH", "CREDIT", amount, "DEPOSIT", depositId, "Deposit refunded");
}

/**
 * Called when staff apply part or all of a HELD deposit against damages
 * (PRD §7.2.4 "applied against damages/final invoice"). The liability
 * clears the same way a refund does, but the offsetting entry is Revenue
 * rather than Cash — no money moves, the business simply keeps what it
 * was already holding, recognized as revenue at the moment of decision.
 */
export async function recordDepositAppliedEntries(
  tx: Prisma.TransactionClient,
  tenantId: string,
  depositId: string,
  amount: string,
) {
  await recordEntry(tx, tenantId, "DEPOSIT_LIABILITY", "DEBIT", amount, "DEPOSIT", depositId, "Deposit applied against damages");
  await recordEntry(tx, tenantId, "REVENUE", "CREDIT", amount, "DEPOSIT", depositId, "Deposit applied against damages");
}

/**
 * Called on credit note issuance against an ISSUED/OVERDUE (unpaid)
 * invoice — reverses the revenue recognized at issue and reduces what's
 * owed. Simplification: treats the full credited amount as a Revenue
 * reversal rather than splitting proportionally across Revenue/TaxPayable
 * — correct for the common case (crediting the whole remaining balance),
 * approximate for a partial credit on a taxed invoice. Tracked in
 * docs/HANDOFF.md.
 */
export async function recordCreditNoteEntries(
  tx: Prisma.TransactionClient,
  tenantId: string,
  creditNoteId: string,
  invoiceId: string,
  amount: string,
) {
  await recordEntry(tx, tenantId, "REVENUE", "DEBIT", amount, "CREDIT_NOTE", creditNoteId, `Credit note against invoice ${invoiceId}`);
  await recordEntry(tx, tenantId, "ACCOUNTS_RECEIVABLE", "CREDIT", amount, "CREDIT_NOTE", creditNoteId, `Credit note against invoice ${invoiceId}`);
}

/**
 * PRD §10 Reliability: "double-entry ledger balances checked nightly."
 * Returns per-account debit/credit totals for a tenant — a genuine
 * double-entry ledger has sum(debits) == sum(credits) across ALL
 * accounts combined (not per-account); apps/worker's ledger-balance-check
 * job calls this and alerts (logs, today) on any drift.
 */
export async function computeLedgerBalance(tx: Prisma.TransactionClient, tenantId: string) {
  const entries = await tx.ledgerEntry.findMany({ where: { tenantId }, select: { entryType: true, amount: true } });
  let totalDebits = 0;
  let totalCredits = 0;
  for (const e of entries) {
    if (e.entryType === "DEBIT") totalDebits += Number(e.amount);
    else totalCredits += Number(e.amount);
  }
  return { totalDebits, totalCredits, balanced: Math.abs(totalDebits - totalCredits) < 0.01 };
}
