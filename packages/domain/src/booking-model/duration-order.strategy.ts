import { BookingModelNotImplementedError } from "./not-implemented.js";

import type { BookingModelStrategy } from "./types.js";

/**
 * Equipment rental, Booqable-style (PRD §5.2). Typed stub — see
 * nightly.strategy.ts for the rationale. Real order/deposit-hold math
 * (PAID(+deposit HELD) -> PICKED_UP -> RETURNED -> INSPECTION) lands in
 * Phase 3.
 */
class DurationOrderStrategy implements BookingModelStrategy {
  readonly kind = "DURATION_ORDER" as const;
  readonly lifecycleVerbs = ["pickup", "return", "inspect"] as const;

  computeInitialInvoice(): never {
    throw new BookingModelNotImplementedError(this.kind, "computeInitialInvoice");
  }

  computeFinalSettlement(): never {
    throw new BookingModelNotImplementedError(this.kind, "computeFinalSettlement");
  }
}

export const durationOrderStrategy: BookingModelStrategy = new DurationOrderStrategy();
