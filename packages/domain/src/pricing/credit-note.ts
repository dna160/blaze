import { Decimal, money, roundMoney, sumMoney } from "../money.js";

import type { InvoiceDraft, InvoiceLineDraft, InvoiceLineType } from "../booking-model/types.js";

export interface InvoiceLineSnapshot {
  description: string;
  amount: Decimal.Value;
  lineType: InvoiceLineType;
}

export interface InvoiceSnapshot {
  lines: InvoiceLineSnapshot[];
  totalAmount: Decimal.Value;
  periodStart: Date | null;
  periodEnd: Date | null;
}

/**
 * PRD §8.2: an invoice "superseded by CREDIT_NOTE + new invoice" — issuing
 * a credit note against an unpaid invoice doesn't just record the credit,
 * it produces the corrected replacement invoice for what's still owed
 * (never edit-in-place). The credit amount is a single dollar figure with
 * no line-level allocation, so every original line is scaled down by the
 * same ratio, preserving each line's `lineType` — that matters downstream:
 * the ledger excludes DEPOSIT (never revenue) and TAX (its own account)
 * from revenue recognition, so collapsing everything into one generic line
 * would misclassify a scaled-down deposit as revenue.
 *
 * `creditAmount` is validated by the caller to be > 0 and <= totalAmount,
 * so `remainingRatio` is always in [0, 1). Rounding each scaled line
 * independently would let the sum drift a cent or two off the intended
 * new total — the last line absorbs that remainder so the replacement
 * invoice's lines always sum to exactly `totalAmount - creditAmount`.
 */
export function computeCreditReplacementDraft(original: InvoiceSnapshot, creditAmount: Decimal.Value): InvoiceDraft {
  const total = money(original.totalAmount);
  const credit = money(creditAmount);
  const newTotal = roundMoney(total.minus(credit));
  const remainingRatio = total.isZero() ? new Decimal(0) : newTotal.dividedBy(total);

  const scaled = original.lines.map((l) => roundMoney(money(l.amount).times(remainingRatio)));
  const drift = newTotal.minus(sumMoney(scaled));
  if (scaled.length > 0) {
    scaled[scaled.length - 1] = scaled[scaled.length - 1]!.plus(drift);
  }

  const lines: InvoiceLineDraft[] = original.lines.map((l, i) => ({
    description: `${l.description} (adjusted)`,
    quantity: new Decimal(1),
    unitPrice: scaled[i]!,
    amount: scaled[i]!,
    lineType: l.lineType,
  }));

  const taxAmount = sumMoney(lines.filter((l) => l.lineType === "TAX").map((l) => l.amount));
  const subtotal = newTotal.minus(taxAmount);

  const now = new Date();
  return {
    lines,
    subtotal,
    taxAmount,
    totalAmount: newTotal,
    periodStart: original.periodStart ?? now,
    periodEnd: original.periodEnd ?? now,
  };
}
