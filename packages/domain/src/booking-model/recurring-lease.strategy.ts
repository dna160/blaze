import { Decimal, roundMoney } from "../money.js";
import { computeDeposit } from "../pricing/deposit.js";
import { nextAnchorDate, periodEndFor, prorateFirstPeriod } from "../pricing/proration.js";

import { buildInvoiceDraft } from "./invoice-builder.js";
import type { BookingModelStrategy, BookingWindow, InvoiceDraft, InvoiceLineDraft, PricingConfig, TenantTaxContext } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

class RecurringLeaseStrategy implements BookingModelStrategy {
  readonly kind = "RECURRING_LEASE" as const;
  readonly lifecycleVerbs = ["move_in", "renew", "terminate"] as const;

  computeInitialInvoice(window: BookingWindow, pricing: PricingConfig, tax: TenantTaxContext): InvoiceDraft {
    const tier = window.rateTier ?? "MONTHLY";
    if (tier === "DAILY" || tier === "WEEKLY") {
      return this.computeFixedTermInvoice(window, pricing, tax, tier);
    }
    return this.computeMonthlyInitialInvoice(window, pricing, tax);
  }

  /**
   * DAILY/WEEKLY rateTier (Travelio-style short stays on a storage/rental
   * unit) — a fixed-term booking, not the indefinite month-to-month lease:
   * one upfront invoice for rate × duration, no proration, no anchorDay
   * (so the recurring-invoice worker job's `anchorDay: { not: null }`
   * filter naturally excludes these from the monthly cycle generator —
   * see apps/worker/src/jobs/generate-recurring-invoices.job.ts). Early
   * termination (GIVE_NOTICE) is explicitly blocked for these at the
   * service layer (BookingService.giveNotice) rather than taught to
   * computeFinalSettlement's month-anchor math, which does not apply here.
   */
  private computeFixedTermInvoice(
    window: BookingWindow,
    pricing: PricingConfig,
    tax: TenantTaxContext,
    tier: "DAILY" | "WEEKLY",
  ): InvoiceDraft {
    if (!window.endDate) {
      throw new Error(`RECURRING_LEASE booking with rateTier ${tier} requires an endDate.`);
    }
    const days = Math.round((window.endDate.getTime() - window.startDate.getTime()) / MS_PER_DAY);
    if (days < 1) {
      throw new Error("endDate must be at least one day after startDate.");
    }

    let rentLine: InvoiceLineDraft;
    let depositBase: Decimal;
    if (tier === "DAILY") {
      if (!pricing.dailyRate || pricing.dailyRate.lessThanOrEqualTo(0)) {
        throw new Error("Daily rate is not configured for this listing.");
      }
      rentLine = {
        description: `Rent (${days} day${days === 1 ? "" : "s"} × ${pricing.dailyRate.toString()})`,
        quantity: new Decimal(days),
        unitPrice: pricing.dailyRate,
        amount: roundMoney(pricing.dailyRate.mul(days)),
        lineType: "RENT",
      };
      depositBase = pricing.dailyRate;
    } else {
      if (!pricing.weeklyRate || pricing.weeklyRate.lessThanOrEqualTo(0)) {
        throw new Error("Weekly rate is not configured for this listing.");
      }
      const weeks = Math.ceil(days / 7);
      rentLine = {
        description: `Rent (${weeks} week${weeks === 1 ? "" : "s"} × ${pricing.weeklyRate.toString()})`,
        quantity: new Decimal(weeks),
        unitPrice: pricing.weeklyRate,
        amount: roundMoney(pricing.weeklyRate.mul(weeks)),
        lineType: "RENT",
      };
      depositBase = pricing.weeklyRate;
    }

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
    const deposit = computeDeposit(pricing.depositRule, depositBase);
    if (deposit.greaterThan(0)) {
      extraLines.push({
        description: "Security deposit",
        quantity: new Decimal(1),
        unitPrice: deposit,
        amount: deposit,
        lineType: "DEPOSIT",
      });
    }

    return buildInvoiceDraft(rentLine, extraLines, tax, pricing, window.startDate, window.endDate);
  }

  private computeMonthlyInitialInvoice(window: BookingWindow, pricing: PricingConfig, tax: TenantTaxContext): InvoiceDraft {
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
