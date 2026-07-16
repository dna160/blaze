import { BookingModelNotImplementedError } from "./not-implemented.js";

import type { BookingModelStrategy } from "./types.js";

/**
 * Venue/studio vertical (PRD §5.2, Phase 3/P2 — furthest out on the
 * roadmap). Typed stub — see nightly.strategy.ts for the rationale.
 */
class HourlySlotStrategy implements BookingModelStrategy {
  readonly kind = "HOURLY_SLOT" as const;
  readonly lifecycleVerbs = ["start", "end"] as const;

  computeInitialInvoice(): never {
    throw new BookingModelNotImplementedError(this.kind, "computeInitialInvoice");
  }

  computeFinalSettlement(): never {
    throw new BookingModelNotImplementedError(this.kind, "computeFinalSettlement");
  }
}

export const hourlySlotStrategy: BookingModelStrategy = new HourlySlotStrategy();
