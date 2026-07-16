import { Decimal, roundMoney, sumMoney } from "../money.js";
import { computeDeposit } from "../pricing/deposit.js";
import { nextAnchorDate, periodEndFor, prorateFirstPeriod } from "../pricing/proration.js";
import { computeTax } from "../pricing/tax.js";

import type {
  BookingModelStrategy,
  BookingWindow,
  InvoiceDraft,
  InvoiceLineDraft,
  PricingConfig,
  TenantTaxContext,
} from "./types.js";

function buildInvoice(
  rentLine: InvoiceLineDraft,
  extraLines: InvoiceLineDraft[],
  tax: TenantTaxContext,
  pricing: PricingConfig,
  periodStart: Date,
  periodEnd: Date,
): InvoiceDraft {
  // Deposits are a balance-sheet liability, never revenue, so they never enter the tax base (PRD §7.2.4).
  const taxableLines = [rentLine, ...extraLines.filter((l) => l.lineType !== "DEPOSIT")];
  const taxableSubtotal = sumMoney(taxableLines.map((l) => l.amount));
  const { taxAmount, grossAmount } = computeTax(taxableSubtotal, {
    isTenantPkp: tax.isTenantPkp,
    taxInclusive: pricing.taxInclusive,
  });

  const lines = [...extraLines, rentLine];
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

class RecurringLeaseStrategy implements BookingModelStrategy {
  readonly kind = "RECURRING_LEASE" as const;
  readonly lifecycleVerbs = ["move_in", "renew", "terminate"] as const;

  computeInitialInvoice(window: BookingWindow, pricing: PricingConfig, tax: TenantTaxContext): InvoiceDraft {
    const rule = pricing.prorationRule ?? "ANCHOR_DATE";
    const proration = prorateFirstPeriod(pricing.basePrice, window.startDate, rule);

    const rentLine: InvoiceLineDraft = {
      description: `Rent (${proration.daysCharged}/${proration.daysInMonth} days, prorated)`,
      quantity: new Decimal(1),
      unitPrice: proration.amount,
      amount: proration.amount,
      lineType: "RENT",
    };

    const extraLines: InvoiceLineDraft[] = [];
    if (pricing.adminFee && pricing.adminFee.greaterThan(0)) {
      extraLines.push({
        description: "Admin fee",
        quantity: new Decimal(1),
        unitPrice: pricing.adminFee,
        amount: pricing.adminFee,
        lineType: "ADMIN_FEE",
      });
    }
    const deposit = computeDeposit(pricing.depositRule, pricing.basePrice);
    if (deposit.greaterThan(0)) {
      extraLines.push({
        description: "Security deposit",
        quantity: new Decimal(1),
        unitPrice: deposit,
        amount: deposit,
        lineType: "DEPOSIT",
      });
    }

    const periodEnd = periodEndFor(window.startDate, proration.anchorDay);
    return buildInvoice(rentLine, extraLines, tax, pricing, window.startDate, periodEnd);
  }

  computeNextCycleInvoice(cycleStart: Date, pricing: PricingConfig, tax: TenantTaxContext): InvoiceDraft {
    const rentLine: InvoiceLineDraft = {
      description: "Rent (full period)",
      quantity: new Decimal(1),
      unitPrice: roundMoney(pricing.basePrice),
      amount: roundMoney(pricing.basePrice),
      lineType: "RENT",
    };
    const periodEnd = periodEndFor(cycleStart, cycleStart.getDate());
    return buildInvoice(rentLine, [], tax, pricing, cycleStart, periodEnd);
  }

  nextCycleDate(anchorDay: number, from: Date): Date {
    return nextAnchorDate(anchorDay, from);
  }

  /**
   * Final invoice on termination: prorated rent from the last full cycle
   * start through the notice-effective end date. Deposit settlement
   * (damage deductions, refund) is handled separately by the finance
   * module — this method only produces the rent-side final invoice line,
   * per PRD §8.4 automation A8 ("compute final invoice + deposit
   * settlement preview -> route to Finance").
   */
  computeFinalSettlement(
    window: BookingWindow,
    pricing: PricingConfig,
    tax: TenantTaxContext,
    effectiveEndDate: Date,
  ): InvoiceDraft {
    const anchorDay = window.anchorDay ?? window.startDate.getDate();
    const daysInMonth = new Date(effectiveEndDate.getFullYear(), effectiveEndDate.getMonth() + 1, 0).getDate();
    const daysCharged = effectiveEndDate.getDate();
    const amount = roundMoney(pricing.basePrice.mul(daysCharged).div(daysInMonth));

    const rentLine: InvoiceLineDraft = {
      description: `Final prorated rent (${daysCharged}/${daysInMonth} days)`,
      quantity: new Decimal(1),
      unitPrice: amount,
      amount,
      lineType: "RENT",
    };

    const periodStart = new Date(effectiveEndDate.getFullYear(), effectiveEndDate.getMonth(), 1);
    return buildInvoice(rentLine, [], tax, pricing, periodStart, effectiveEndDate);
  }
}

export const recurringLeaseStrategy: BookingModelStrategy = new RecurringLeaseStrategy();
