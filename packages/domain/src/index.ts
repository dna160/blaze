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
export {
  TERM_OPTIONS_MONTHS,
  isValidTermMonths,
  addMonthsClamped,
  addDays,
  termEndDate,
  proformaDueDate,
  computeTermSchedule,
  type TermMonths,
  type SchedulePeriod,
  type TermScheduleOptions,
} from "./pricing/term-schedule.js";
export {
  holdWindowEnd,
  holdWindowsOverlap,
  isUnitFreeFor,
  type HoldWindowInput,
  type CommittedBookingLike,
  type AvailabilityCheckOptions,
} from "./availability/blackout.js";
export { classifyCustomerHealth, type CustomerHealth, type CustomerHealthInput } from "./crm/customer-health.js";
export { bucketReceivables, type ArAgingBuckets, type ReceivableLike } from "./finance/ar-aging.js";

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

export {
  BILLING_PLANS,
  OVERAGE_PRICE_PER_ASSET_IDR,
  computeMonthlyCharge,
  type BillingPlanKey,
  type BillingPlanDefinition,
  type MonthlyChargeResult,
} from "./billing/plans.js";
export { renderMessage, buildMagicLinkUrl, type RenderedMessage } from "./comms/templates.js";
