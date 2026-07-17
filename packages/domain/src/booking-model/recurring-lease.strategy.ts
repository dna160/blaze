import { Decimal, roundMoney } from "../money.js";
import { computeDeposit } from "../pricing/deposit.js";
import { nextAnchorDate, periodEndFor, prorateFirstPeriod } from "../pricing/proration.js";

import { buildInvoiceDraft } from "./invoice-builder.js";
import type { BookingModelStrategy, BookingWindow, InvoiceDraft, InvoiceLineDraft, PricingConfig, TenantTaxContext } from "./types.js";

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
    return buildInvoiceDraft(rentLine, extraLines, tax, pricing, window.startDate, periodEnd);
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
    return buildInvoiceDraft(rentLine, [], tax, pricing, cycleStart, periodEnd);
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
    return buildInvoiceDraft(rentLine, [], tax, pricing, periodStart, effectiveEndDate);
  }
}

export const recurringLeaseStrategy: BookingModelStrategy = new RecurringLeaseStrategy();
