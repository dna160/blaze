import { z } from "zod";

/**
 * PRD go-live 2 §3 — the deposit report (Console → Deposit).
 *
 * The date range (`from`/`to`, inclusive branch-timezone dates — see
 * report-range.ts) applies to MOVEMENT dates: the totals count what was
 * received, applied and refunded inside it, and what was still held at its
 * end. The rows are the deposits that matter to that range: every deposit
 * still held at the end of it, plus any that moved inside it.
 */

export const DepositSourceSchema = z.enum(["RENTOS", "LEGACY"]);
export type DepositSource = z.infer<typeof DepositSourceSchema>;

export const DepositReportStatusSchema = z.enum(["HELD", "PARTIALLY_APPLIED", "APPLIED", "REFUND_REQUESTED", "REFUNDED"]);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const flag = z
  .enum(["1", "true", "0", "false"])
  .optional()
  .transform((v) => v === "1" || v === "true");

export const DepositReportQuerySchema = z.object({
  /** Omit both for "this month" in the branch's timezone. */
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: DepositReportStatusSchema.optional(),
  assetTypeId: z.string().uuid().optional(),
  source: DepositSourceSchema.optional(),
  /** Only deposits whose refund is past due (refundDueAt before today, not refunded, something left). */
  refundOverdue: flag,
  /** Only deposits with a movement inside the range (leave out the ones merely still held). */
  movedOnly: flag,
});
export type DepositReportQuery = z.infer<typeof DepositReportQuerySchema>;

export interface DepositReportRow {
  id: string;
  bookingId: string;
  customerId: string | null;
  customerName: string;
  customerNumber: number | null;
  contractNumber: string | null;
  unitCode: string | null;
  unitTypeId: string;
  unitTypeName: string;
  source: DepositSource;
  amount: string;
  appliedAmount: string;
  /** amount − applied; 0 once refunded. */
  remaining: string;
  status: z.infer<typeof DepositReportStatusSchema>;
  /** Instant the money arrived (legacy: the import). */
  receivedAt: string;
  /** Calendar date (YYYY-MM-DD) the lease ends, when known. */
  leaseEnd: string | null;
  /** Calendar date the refund is due: lease end + 30 days. */
  refundDue: string | null;
  refundOverdue: boolean;
  refundRequestedAt: string | null;
  refundedAt: string | null;
  payoutRef: string | null;
  /**
   * What this deposit still held at the END of the range. Equals `remaining`
   * for a range that reaches today; differs for a past range if the deposit
   * moved since. The totals strip adds up this column, not `remaining`.
   */
  heldAtEnd: string;
  /** What this deposit did inside the range. */
  receivedInRange: string;
  appliedInRange: string;
  refundedInRange: string;
}

export interface DepositReportTotals {
  /** Still held at the end of the range (received − applied − refunded up to then). */
  heldAtEnd: string;
  /** Held just before the range began. */
  heldAtStart: string;
  receivedInRange: string;
  appliedInRange: string;
  refundedInRange: string;
  /** Legacy re-sync corrections inside the range (signed). Zero for a branch that never imported. */
  adjustedInRange: string;
  refundsOverdueCount: number;
  refundsOverdueAmount: string;
  depositCount: number;
}

export interface DepositReport {
  range: { from: string; to: string };
  timeZone: string;
  /** `{branchCode}_deposits_{from}_{to}.csv` — what the download is saved as. */
  exportFilename: string;
  /** True when a row filter (status / unit type / source / overdue / moved) narrows the totals below. */
  filtered: boolean;
  /** Over the rows shown (i.e. after the filters). */
  totals: DepositReportTotals;
  /**
   * PRD §3.2 acceptance — always for the WHOLE branch, whatever the filters:
   * what the deposit records say is held at the end of the range against the
   * DEPOSIT_LIABILITY balance of the ledger at that same instant.
   */
  reconciliation: {
    heldAtEnd: string;
    ledgerBalance: string;
    difference: string;
    matches: boolean;
  };
  unitTypes: Array<{ id: string; name: string }>;
  rows: DepositReportRow[];
}
