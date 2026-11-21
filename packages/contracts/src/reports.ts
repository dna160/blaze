import { z } from "zod";

/**
 * PRD go-live 2 §2 — the reports the console reads. Every report takes
 * `from`/`to` as INCLUSIVE calendar dates in the branch's timezone
 * (see report-range.ts) and says which range and zone it answered for.
 * Amounts are decimal strings in rupiah, as everywhere else in the API.
 */

export const ReportRangeQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

export interface ReportRangeInfo {
  from: string;
  to: string;
  timeZone: string;
}

/** What the console needs to label a report and name its files. */
export interface ReportBranchInfo {
  code: string;
  name: string;
  isPkp: boolean;
}

// ── §2.3 Financial summary ("Ringkasan keuangan") ──────────────────────────

export interface LedgerAccountSummary {
  account: string;
  /** The side the account grows on; balances are positive on that side. */
  normalSide: "DEBIT" | "CREDIT";
  opening: string;
  debit: string;
  credit: string;
  closing: string;
}

export interface FinancialSummaryResponse {
  range: ReportRangeInfo;
  branch: ReportBranchInfo;
  /** Net REVENUE movement in the range (accrual: recognized at invoice issue). */
  revenueRecognized: string;
  /** Invoices issued in the range, deposits excluded. VOID and credited invoices are not counted. */
  invoiced: { count: number; amount: string };
  /** Payments that reached SUCCEEDED in the range, by paidAt. Includes any deposit paid with them. */
  received: { count: number; amount: string };
  depositsReceived: string;
  /** Deposits paid back in the range. */
  refunds: string;
  /** Balances as of the END of the range. */
  accountsReceivable: string;
  depositsHeld: string;
  /** Null when the branch is not PKP (§2.6) — the console then shows "Tidak PKP". */
  taxPayable: string | null;
  accounts: LedgerAccountSummary[];
}

/** The shape `GET /reports/month-end?year&month` has always returned; now computed on the branch-timezone month. */
export interface MonthEndCloseResponse {
  period: { year: number; month: number };
  revenueRecognized: string;
  depositsHeld: string;
  accountsReceivable: string;
  refunds: string;
  taxPayable: string;
}

// ── §2.2 Sales report ("Penjualan") ────────────────────────────────────────

export const SalesGroupBySchema = z.enum(["day", "week", "month"]);
export type SalesGroupBy = z.infer<typeof SalesGroupBySchema>;

/** Which payments the transaction list shows. "SUCCEEDED" (sukses saja) is the default. */
export const SalesTransactionStatusSchema = z.enum(["SUCCEEDED", "PENDING", "FAILED", "ALL"]);
export type SalesTransactionStatus = z.infer<typeof SalesTransactionStatusSchema>;

export interface SalesPeriodRow {
  /** YYYY-MM-DD (day), the Monday's YYYY-MM-DD (week) or YYYY-MM (month). */
  period: string;
  invoiced: string;
  received: string;
  depositsReceived: string;
  depositsRefunded: string;
  /** received − depositsRefunded. */
  netCashIn: string;
}

export interface SalesTransactionRow {
  paymentId: string;
  invoiceId: string;
  /** paidAt, or createdAt for a payment that has not succeeded. ISO instant. */
  at: string;
  /** `YYYY-MM-DD HH:mm` in the branch timezone. */
  atLocal: string;
  customerId: string;
  customer: string | null;
  customerNumber: number | null;
  contractNumber: string | null;
  invoiceNumber: string;
  unit: string | null;
  method: string;
  provider: string;
  reference: string | null;
  amount: string;
  /** SUCCEEDED | PENDING (awaiting verification) | FAILED | REFUNDED | PARTIALLY_REFUNDED */
  status: string;
  recordedBy: string | null;
  verifiedBy: string | null;
}

export interface SalesReportResponse {
  range: ReportRangeInfo;
  branch: ReportBranchInfo;
  groupBy: SalesGroupBy;
  summary: {
    invoicesIssued: { count: number; amount: string };
    paymentsReceived: { count: number; amount: string; byMethod: Array<{ method: string; count: number; amount: string }> };
    depositsReceived: { count: number; amount: string };
    depositsRefunded: { count: number; amount: string };
    rentalsStarted: number;
    rentalsEnded: number;
    creditNotes: { count: number; amount: string };
    netCashIn: string;
  };
  periods: SalesPeriodRow[];
  filter: { status: SalesTransactionStatus; method: string | null };
  transactions: SalesTransactionRow[];
}

// ── §2.5 AR aging drill-down ───────────────────────────────────────────────

export const AR_AGING_BUCKET_KEYS = [
  "overdue_current",
  "overdue_1_30",
  "overdue_31_60",
  "overdue_60_plus",
  "coming_0_30",
  "coming_31_60",
  "coming_61_90",
  "beyond_horizon",
] as const;
export type ArAgingBucketKey = (typeof AR_AGING_BUCKET_KEYS)[number];

export interface ArAgingRow {
  invoiceId: string;
  bucket: ArAgingBucketKey;
  customerId: string;
  customer: string | null;
  customerNumber: number | null;
  contractNumber: string | null;
  invoiceNumber: string;
  unit: string | null;
  /** YYYY-MM-DD in the branch timezone. */
  dueDate: string;
  /** Days past due as of the report date; negative = days until due. */
  daysOverdue: number;
  amountOutstanding: string;
  status: string;
  /** ISO instant of the latest payment reminder that actually went out for this invoice, if any. */
  lastReminderAt: string | null;
  lastReminderTemplate: string | null;
}
