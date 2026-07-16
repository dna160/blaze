import { BookingModelNotImplementedError } from "./not-implemented.js";

import type { BookingModelStrategy } from "./types.js";

/**
 * Hotel/villa vertical (PRD §5.2). Typed stub: proves NIGHTLY plugs into
 * the same BookingModelStrategy seam as RECURRING_LEASE without touching
 * booking/finance orchestration code. Real check-in/night-rate math lands
 * in Phase 3 when a hotel/kost tenant is actually onboarded.
 */
class NightlyStrategy implements BookingModelStrategy {
  readonly kind = "NIGHTLY" as const;
  readonly lifecycleVerbs = ["check_in", "check_out", "extend"] as const;

  computeInitialInvoice(): never {
    throw new BookingModelNotImplementedError(this.kind, "computeInitialInvoice");
  }

  computeFinalSettlement(): never {
    throw new BookingModelNotImplementedError(this.kind, "computeFinalSettlement");
  }
}

export const nightlyStrategy: BookingModelStrategy = new NightlyStrategy();
