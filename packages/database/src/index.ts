export * from "../generated/client/index.js";
export { getPrismaClient, createPrismaClient } from "./client.js";
export { withTenantContext, InvalidTenantIdError } from "./tenant-context.js";
export { withPlatformContext } from "./platform-context.js";
export { generateMonthlyPlatformInvoices } from "./platform-billing.js";
export { nextInvoiceNumber } from "./invoice-number.js";
export {
  generateInitialInvoice,
  generateNextCycleInvoice,
  generateFinalSettlement,
  generateTermPaymentSchedule,
  issueScheduledInvoice,
  voidScheduledInvoices,
  provisionalInvoiceNumber,
  markInvoicePaid,
  markInvoiceOverdue,
  createCreditReplacementInvoice,
  toPricingConfig,
  type BookingForInvoicing,
  type InvoiceForCredit,
  type InvoiceLineForCredit,
  type PersistInvoiceOptions,
} from "./invoicing.js";
export {
  UNIT_HOLDING_STATUSES,
  listAvailableStorageAssets,
  countAvailableStorageAssets,
  findAvailableStorageAsset,
  resolveBlackoutMonths,
  resolveInvoiceLeadDays,
  type StorageWindow,
  type StorageAvailabilityOptions,
} from "./storage-availability.js";
export { findOrCreateCustomerAccessToken, exchangeCustomerAccessToken, hashAccessToken, MAGIC_LINK_TTL_DAYS } from "./magic-link.js";
export {
  recordPaymentReceivedEntries,
  recordDepositHeldEntries,
  recordDepositRefundedEntries,
  recordDepositAppliedEntries,
  recordCreditNoteEntries,
  computeLedgerBalance,
} from "./ledger.js";
export { computePooledAvailableCount, findAvailablePooledAsset, type PooledAssetType } from "./pooled-availability.js";
export { findAvailableNonPooledAsset } from "./ota-blocking.js";
export { generateIcalFeed, parseIcalEvents, type IcalEvent } from "./ical.js";
