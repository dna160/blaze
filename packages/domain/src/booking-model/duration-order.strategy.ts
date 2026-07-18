import { Decimal, roundMoney } from "../money.js";
import { computeDeposit } from "../pricing/deposit.js";

import { buildInvoiceDraft } from "./invoice-builder.js";
import { BookingModelNotImplementedError } from "./not-implemented.js";
import type { BookingModelStrategy, BookingWindow, InvoiceDraft, InvoiceLineDraft, PricingConfig, TenantTaxContext } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Equipment rental, Booqable-style (PRD §5.2). `pricing.basePrice` is the
 * per-day rate for a DURATION_ORDER AssetType — same field, same reuse
 * pattern as NightlyStrategy's per-night rate. PAID(+deposit HELD) ->
 * PICKED_UP -> RETURNED -> INSPECTION -> CLOSED (see
 * `durationOrderBookingFsm`); the lifecycle actions live in
 * `BookingService.pickUp/returnEquipment/completeInspection`.
 */
class DurationOrderStrategy implements BookingModelStrategy {
  readonly kind = "DURATION_ORDER" as const;
  readonly lifecycleVerbs = ["pickup", "return", "inspect"] as const;

  computeInitialInvoice(window: BookingWindow, pricing: PricingConfig, tax: TenantTaxContext): InvoiceDraft {
    if (!window.endDate) {
      throw new Error("DURATION_ORDER booking requires an endDate (return date) to compute days x rate.");
    }
    const days = Math.round((window.endDate.getTime() - window.startDate.getTime()) / MS_PER_DAY);
    if (days < 1) {
      throw new Error("DURATION_ORDER booking endDate must be at least one day after startDate.");
    }

    const dailyRate = roundMoney(pricing.basePrice);
    const amount = roundMoney(dailyRate.mul(days));
    const rentLine: InvoiceLineDraft = {
      description: `Rental fee (${days} day${days === 1 ? "" : "s"} × ${dailyRate.toString()})`,
      quantity: new Decimal(days),
      unitPrice: dailyRate,
      amount,
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

    return buildInvoiceDraft(rentLine, extraLines, tax, pricing, window.startDate, window.endDate);
  }

  /**
   * DURATION_ORDER's golden path has no early-return path today (see
   * `durationOrderBookingFsm` — RETURNED only goes forward through
   * INSPECTION to CLOSED), so this is legitimately unreachable and stays
   * a stub. Damage deductions against the deposit are handled by the
   * existing `DepositsService.applyToDamages` workflow (Session 12), not
   * a settlement invoice — same reasoning as NightlyStrategy. Tracked in
   * docs/HANDOFF.md.
   */
  computeFinalSettlement(): never {
    throw new BookingModelNotImplementedError(this.kind, "computeFinalSettlement");
  }
}

export const durationOrderStrategy: BookingModelStrategy = new DurationOrderStrategy();
