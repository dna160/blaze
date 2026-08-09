export { Decimal, money, roundMoney, sumMoney } from "./money.js";

export { computeTax, DEFAULT_PPN_RATE, type TaxResult } from "./pricing/tax.js";
export { computeDeposit, type DepositRule } from "./pricing/deposit.js";
export {
  prorateFirstPeriod,
  nextAnchorDate,
  periodEndFor,
  type ProrationRule,
  type ProrationResult,
} from "./pricing/proration.js";
export {
  computeCreditReplacementDraft,
  type InvoiceSnapshot,
  type InvoiceLineSnapshot,
} from "./pricing/credit-note.js";
export {
  computeSwapProration,
  type SwapProrationParams,
  type SwapProrationResult,
} from "./pricing/swap-proration.js";
export {
  computeNightlyRateBreakdown,
  sumNightlyRateBreakdown,
  type SeasonalRate,
  type NightlyRateGroup,
} from "./pricing/seasonal.js";

export type {
  BookingModelStrategy,
  BookingModelKind,
  BookingWindow,
  PricingConfig,
  InvoiceDraft,
  InvoiceLineDraft,
  InvoiceLineType,
  TenantTaxContext,
} from "./booking-model/types.js";
export { recurringLeaseStrategy } from "./booking-model/recurring-lease.strategy.js";
export { nightlyStrategy } from "./booking-model/nightly.strategy.js";
export { durationOrderStrategy } from "./booking-model/duration-order.strategy.js";
export { hourlySlotStrategy } from "./booking-model/hourly-slot.strategy.js";
export { getBookingModelStrategy } from "./booking-model/registry.js";
export { BookingModelNotImplementedError } from "./booking-model/not-implemented.js";

export { StateMachine, IllegalTransitionError, GuardFailedError } from "./state-machine/fsm.js";
export {
  recurringLeaseBookingFsm,
  nightlyBookingFsm,
  durationOrderBookingFsm,
  type BookingStatus,
  type BookingEvent,
  type BookingActivationContext,
} from "./state-machine/booking-fsm.js";
export { invoiceFsm, type InvoiceStatus, type InvoiceEvent } from "./state-machine/invoice-fsm.js";
export { assetFsm, type AssetStatus, type AssetEvent } from "./state-machine/asset-fsm.js";

// BUILD-SPEC C2 — role × scope RBAC (authoritative capability matrix).
export {
  CAPABILITY_MATRIX,
  ALL_CAPABILITIES,
  CLIENT_ROLE_ENCODING,
  can,
  capabilitiesFor,
  roleAppliesToTenant,
  hasOrganizationScope,
  type BaseRole,
  type RoleScope,
  type Capability,
  type RoleAssignment,
} from "./rbac/capability-matrix.js";

// BUILD-SPEC C4 — rental-order lifecycle state machine.
export {
  rentalOrderFsm,
  RENTAL_ORDER_TRANSITIONS,
  type RentalOrderStatus,
  type RentalOrderEvent,
} from "./rental-order/rental-order-fsm.js";

// BUILD-SPEC C3 — monthly-only billing guard.
export {
  wholeMonthsBetween,
  assertWholeMonths,
  monthlyPeriodEnd,
  NonIntegerMonthError,
  SubMonthlyDisabledError,
  type BillingUnit,
} from "./rental-order/monthly-guard.js";

// BUILD-SPEC C5 — waitlist queue + single-fire + payment-TTL rules.
export {
  nextArmedEntry,
  resequencePositions,
  computeFireExpiry,
  isFireExpired,
  type WaitlistStatus,
  type WaitlistEntryLike,
} from "./waitlist/waitlist-rules.js";

// #30/#31/#32 — pricing: bundle discount, duration discount, manual override.
export {
  bundleDiscount,
  durationDiscount,
  applyPriceOverride,
  composeMonthlyRate,
  type BundleTier,
  type DurationTier,
  type PriceComposition,
} from "./pricing/discounts.js";
