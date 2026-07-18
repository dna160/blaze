import { Decimal, roundMoney, sumMoney } from "../money.js";
import { computeTax } from "../pricing/tax.js";

import type { InvoiceDraft, InvoiceLineDraft, PricingConfig, TenantTaxContext } from "./types.js";

/**
 * Shared line-assembly + tax math for every BookingModelStrategy's invoice
 * drafts. Pulled out of RecurringLeaseStrategy so NightlyStrategy (and
 * future strategies) reuse the exact same deposit/tax handling instead of
 * a second hand-copied version drifting out of sync.
 */
export function buildInvoiceDraft(
  primaryLines: InvoiceLineDraft | InvoiceLineDraft[],
  extraLines: InvoiceLineDraft[],
  tax: TenantTaxContext,
  pricing: PricingConfig,
  periodStart: Date,
  periodEnd: Date,
): InvoiceDraft {
  const primary = Array.isArray(primaryLines) ? primaryLines : [primaryLines];

  // Deposits are a balance-sheet liability, never revenue, so they never enter the tax base (PRD §7.2.4).
  const taxableLines = [...primary, ...extraLines.filter((l) => l.lineType !== "DEPOSIT")];
  const taxableSubtotal = sumMoney(taxableLines.map((l) => l.amount));
  const { taxAmount, grossAmount } = computeTax(taxableSubtotal, {
    isTenantPkp: tax.isTenantPkp,
    taxInclusive: pricing.taxInclusive,
  });

  const lines = [...extraLines, ...primary];
  if (taxAmount.greaterThan(0)) {
    lines.push({
      description: "PPN 11%",
      quantity: new Decimal(1),
      unitPrice: taxAmount,
      amount: taxAmount,
      lineType: "TAX",
    });
  }

  const depositTotal = sumMoney(extraLines.filter((l) => l.lineType === "DEPOSIT").map((l) => l.amount));

  return {
    lines,
    subtotal: roundMoney(taxableSubtotal.plus(depositTotal)),
    taxAmount,
    totalAmount: roundMoney(grossAmount.plus(depositTotal)),
    periodStart,
    periodEnd,
  };
}
