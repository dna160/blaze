/**
 * PRD go-live 2 §10.1 (part 1 §8.3–8.4) — settling an invoice net of PPh.
 *
 * The invoice total stays the legal amount owed (DPP + PPN). A company that
 * withholds PPh transfers the total minus the withheld tax and hands over a
 * bukti potong; the invoice is PAID when transfer + withheld covers the total
 * (within Rp 1 rounding). A short payment leaves the invoice open with the
 * balance shown. Ledger, per verified payment: Dr CASH (transfer), Dr
 * PREPAID_TAX_PPH (withheld), Cr ACCOUNTS_RECEIVABLE (transfer + withheld) —
 * with the deposit's cash carved out of the closing payment, because the
 * deposit never sat in AR (it is posted Dr CASH / Cr DEPOSIT_LIABILITY).
 *
 * Pure. All amounts are whole rupiah numbers.
 */

export type PphType = "PPH_4_2_FINAL" | "PPH_23";

export const DEFAULT_PPH_RATES: Readonly<Record<PphType, number>> = { PPH_4_2_FINAL: 0.1, PPH_23: 0.02 };

/** Rp 1 either way still counts as settled (part 1 §8.4). */
export const SETTLEMENT_TOLERANCE = 1;

/** The withholding a customer is expected to make on `dpp` (the rent and other charges — never the deposit, never the PPN). */
export function expectedPphWithholding(dpp: number, type: PphType | null | undefined, rates?: Partial<Record<string, number>> | null): { type: PphType; rate: number; amount: number } {
  const t: PphType = type === "PPH_23" ? "PPH_23" : "PPH_4_2_FINAL";
  const configured = rates?.[t];
  const rate = typeof configured === "number" && configured >= 0 && configured <= 0.5 ? configured : DEFAULT_PPH_RATES[t];
  return { type: t, rate, amount: Math.round(dpp * rate) };
}

export interface SettlementState {
  total: number;
  /** Transfer + withheld already settled by earlier verified payments. */
  settled: number;
}

export interface SettlementOutcome {
  /** What this payment settles: transfer + withheld. */
  settles: number;
  settledAfter: number;
  outstandingAfter: number;
  paidInFull: boolean;
}

export class SettlementError extends Error {}

/** Apply one payment (transfer `amount`, `withheld` PPh) to an invoice. Refuses overpayment beyond the tolerance. */
export function applySettlement(state: SettlementState, amount: number, withheld: number): SettlementOutcome {
  if (!(amount >= 0) || !(withheld >= 0)) throw new SettlementError("Amounts cannot be negative.");
  if (amount + withheld <= 0) throw new SettlementError("The payment settles nothing.");
  const outstanding = state.total - state.settled;
  const settles = amount + withheld;
  if (settles > outstanding + SETTLEMENT_TOLERANCE) {
    throw new SettlementError(`Transfer + PPh (Rp ${settles.toLocaleString("id-ID")}) is more than the outstanding Rp ${outstanding.toLocaleString("id-ID")}.`);
  }
  const settledAfter = state.settled + settles;
  const outstandingAfter = Math.max(0, state.total - settledAfter);
  return { settles, settledAfter, outstandingAfter, paidInFull: outstandingAfter <= SETTLEMENT_TOLERANCE };
}

/**
 * The ledger lines for one verified payment. `depositShare` is the invoice's
 * deposit (0 when none): on the CLOSING payment its cash is left to the
 * deposit entries, so AR is credited exactly total − deposit over all payments.
 */
export function settlementLedger(params: { amount: number; withheld: number; closing: boolean; depositShare: number }): { cash: number; prepaidPph: number; arCredit: number } {
  const carve = params.closing ? params.depositShare : 0;
  if (carve > params.amount) {
    throw new SettlementError("The deposit must be part of the final transfer: this payment closes the invoice but transfers less than the deposit.");
  }
  return { cash: params.amount - carve, prepaidPph: params.withheld, arCredit: params.amount + params.withheld - carve };
}
