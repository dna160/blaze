import { Decimal, roundMoney } from "../money.js";
import { computeDeposit } from "../pricing/deposit.js";

import { buildInvoiceDraft } from "./invoice-builder.js";
import { BookingModelNotImplementedError } from "./not-implemented.js";
import type { BookingModelStrategy, BookingWindow, InvoiceDraft, InvoiceLineDraft, PricingConfig, TenantTaxContext } from "./types.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Hotel/villa/kost-by-night vertical (PRD §5.2). `pricing.basePrice` is the
 * per-night rate for a NIGHTLY AssetType (as opposed to the per-month rate
 * it represents for RECURRING_LEASE) — the field is reused, only its unit
 * changes per booking model, same as every other PricingConfig consumer.
 */
class NightlyStrategy implements BookingModelStrategy {
  readonly kind = "NIGHTLY" as const;
  readonly lifecycleVerbs = ["check_in", "check_out", "extend"] as const;

  computeInitialInvoice(window: BookingWindow, pricing: PricingConfig, tax: TenantTaxContext): InvoiceDraft {
    if (!window.endDate) {
      throw new Error("NIGHTLY booking requires an endDate (checkout date) to compute nights x rate.");
    }
    const nights = Math.round((window.endDate.getTime() - window.startDate.getTime()) / MS_PER_DAY);
    if (nights < 1) {
      throw new Error("NIGHTLY booking endDate must be at least one night after startDate.");
    }

    const nightlyRate = roundMoney(pricing.basePrice);
    const amount = roundMoney(nightlyRate.mul(nights));
    const rentLine: InvoiceLineDraft = {
      description: `Room rate (${nights} night${nights === 1 ? "" : "s"} × ${nightlyRate.toString()})`,
      quantity: new Decimal(nights),
      unitPrice: nightlyRate,
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
   * NIGHTLY's golden path has no GIVE_NOTICE-style early-exit transition
   * today (see `nightlyBookingFsm` — CHECKED_IN only goes forward to
   * CHECKED_OUT via the normal check-out action), so this is legitimately
   * unreachable and stays a stub. Early checkout / EXTENDED (PRD Appendix
   * B) is deferred, tracked in docs/HANDOFF.md.
   */
  computeFinalSettlement(): never {
    throw new BookingModelNotImplementedError(this.kind, "computeFinalSettlement");
  }
}

export const nightlyStrategy: BookingModelStrategy = new NightlyStrategy();
