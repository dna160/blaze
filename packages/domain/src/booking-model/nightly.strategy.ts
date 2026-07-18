import { Decimal, roundMoney } from "../money.js";
import { computeDeposit } from "../pricing/deposit.js";
import { computeNightlyRateBreakdown } from "../pricing/seasonal.js";

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

    // One RENT line per contiguous seasonal-rate group (PRD §7.2.3 P2)
    // rather than a single blended nights x rate figure, so a stay that
    // crosses a seasonal boundary shows the customer exactly which
    // nights cost what. With no seasonalRates configured this collapses
    // to the same single nights x rate line as before.
    const breakdown = computeNightlyRateBreakdown(window.startDate, window.endDate, roundMoney(pricing.basePrice), pricing.seasonalRates);
    const rentLines: InvoiceLineDraft[] = breakdown.map((g) => ({
      description: g.label
        ? `Room rate (${g.nights} night${g.nights === 1 ? "" : "s"} × ${g.rate.toString()} — ${g.label})`
        : `Room rate (${g.nights} night${g.nights === 1 ? "" : "s"} × ${g.rate.toString()})`,
      quantity: new Decimal(g.nights),
      unitPrice: g.rate,
      amount: roundMoney(g.rate.mul(g.nights)),
      lineType: "RENT",
    }));

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

    return buildInvoiceDraft(rentLines, extraLines, tax, pricing, window.startDate, window.endDate);
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
