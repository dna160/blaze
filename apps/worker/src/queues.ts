import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";

import { deliverTenantWebhook, markWebhookDeliveryFailed, type WebhookDeliveryJobPayload } from "./jobs/deliver-tenant-webhook.job.js";
import { runDunningLadder } from "./jobs/dunning-ladder.job.js";
import { runGenerateRecurringInvoices } from "./jobs/generate-recurring-invoices.job.js";
import { runIssueScheduledInvoices } from "./jobs/issue-scheduled-invoices.job.js";
import { runLedgerBalanceCheck } from "./jobs/ledger-balance-check.job.js";
import { runTermLifecycle } from "./jobs/term-lifecycle.job.js";
import { runPlatformBilling } from "./jobs/platform-billing.job.js";
import { runRenewalOffers } from "./jobs/renewal-offer.job.js";
import { runRenewalTimeouts } from "./jobs/renewal-timeout.job.js";
import { runSyncOtaCalendars } from "./jobs/sync-ota-calendars.job.js";
import { runWaitlistExpiry } from "./jobs/waitlist-expiry.job.js";

export const INVOICE_GENERATION_QUEUE = "invoice-generation";
/** PRD v2 §8 — issues the SCHEDULED cycles of term payment schedules on their issue date. */
export const SCHEDULED_INVOICE_ISSUE_QUEUE = "scheduled-invoice-issue";
/** PRD v2 P6 — expires stale requests, ends terms, applies notice dates. */
export const TERM_LIFECYCLE_QUEUE = "term-lifecycle";
export const DUNNING_LADDER_QUEUE = "dunning-ladder";
export const LEDGER_BALANCE_CHECK_QUEUE = "ledger-balance-check";
export const RENEWAL_OFFER_QUEUE = "renewal-offer";
export const RENEWAL_TIMEOUT_QUEUE = "renewal-timeout";
export const WAITLIST_EXPIRY_QUEUE = "waitlist-expiry";
export const OTA_CALENDAR_SYNC_QUEUE = "ota-calendar-sync";
export const PLATFORM_BILLING_QUEUE = "platform-billing";
/** Must match apps/api/src/webhook-dispatch/webhook-dispatch.service.ts's TENANT_WEBHOOK_DELIVERY_QUEUE exactly — that's the producer, this file's Worker is the consumer. */
export const TENANT_WEBHOOK_DELIVERY_QUEUE = "tenant-webhook-delivery";

export function createRedisConnection(): IORedis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set.");
  // BullMQ requires this exact option — it manages blocking commands itself.
  return new IORedis(url, { maxRetriesPerRequest: null });
}

/**
 * Every scheduled job in the stack. Registered as BullMQ repeatable jobs
 * rather than plain setIntervals so retries, concurrency, and
 * observability come from the same queue infra as everything else (PRD
 * §11: "BullMQ workers (invoicing, dunning, webhooks)").
 *
 * Most run daily (PRD §8.2 "Recurring generator runs daily"; §7.2.4
 * dunning ladder; §10 "double-entry ledger balances checked nightly").
 * The two hourly ones and the monthly one say why inline.
 */
export async function scheduleRepeatableJobs(connection: IORedis): Promise<void> {
  const invoiceQueue = new Queue(INVOICE_GENERATION_QUEUE, { connection });
  const dunningQueue = new Queue(DUNNING_LADDER_QUEUE, { connection });
  const ledgerQueue = new Queue(LEDGER_BALANCE_CHECK_QUEUE, { connection });
  const renewalOfferQueue = new Queue(RENEWAL_OFFER_QUEUE, { connection });
  const renewalTimeoutQueue = new Queue(RENEWAL_TIMEOUT_QUEUE, { connection });
  const waitlistExpiryQueue = new Queue(WAITLIST_EXPIRY_QUEUE, { connection });
  const otaSyncQueue = new Queue(OTA_CALENDAR_SYNC_QUEUE, { connection });
  const platformBillingQueue = new Queue(PLATFORM_BILLING_QUEUE, { connection });
  const scheduledIssueQueue = new Queue(SCHEDULED_INVOICE_ISSUE_QUEUE, { connection });
  const termLifecycleQueue = new Queue(TERM_LIFECYCLE_QUEUE, { connection });

  // PRD v2: run the term clock before the invoice issuer so a lease that
  // ended today doesn't get a cycle issued in the same tick.
  await termLifecycleQueue.add(
    "tick",
    {},
    { repeat: { pattern: process.env.TERM_LIFECYCLE_CRON ?? "30 0 * * *" }, jobId: "term-lifecycle-daily" },
  );
  await scheduledIssueQueue.add(
    "tick",
    {},
    { repeat: { pattern: process.env.SCHEDULED_INVOICE_ISSUE_CRON ?? "45 0 * * *" }, jobId: "scheduled-invoice-issue-daily" },
  );

  await invoiceQueue.add(
    "tick",
    {},
    { repeat: { pattern: process.env.INVOICE_GENERATION_CRON ?? "0 1 * * *" }, jobId: "invoice-generation-daily" },
  );
  await dunningQueue.add(
    "tick",
    {},
    { repeat: { pattern: process.env.DUNNING_LADDER_CRON ?? "0 2 * * *" }, jobId: "dunning-ladder-daily" },
  );
  await ledgerQueue.add(
    "tick",
    {},
    { repeat: { pattern: process.env.LEDGER_BALANCE_CHECK_CRON ?? "0 3 * * *" }, jobId: "ledger-balance-check-daily" },
  );
  // C4 — renewal offers (H-14) and no-reply timeouts (B1, H-7), daily.
  await renewalOfferQueue.add(
    "tick",
    {},
    { repeat: { pattern: process.env.RENEWAL_OFFER_CRON ?? "0 4 * * *" }, jobId: "renewal-offer-daily" },
  );
  await renewalTimeoutQueue.add(
    "tick",
    {},
    { repeat: { pattern: process.env.RENEWAL_TIMEOUT_CRON ?? "0 5 * * *" }, jobId: "renewal-timeout-daily" },
  );
  // C5 — waitlist payment TTL sweep. Hourly, since the TTL is measured in hours.
  await waitlistExpiryQueue.add(
    "tick",
    {},
    { repeat: { pattern: process.env.WAITLIST_EXPIRY_CRON ?? "0 * * * *" }, jobId: "waitlist-expiry-hourly" },
  );
  // Hourly, not daily — OTA availability changes throughout the day and a
  // stale block window risks a real double-booking, unlike the daily jobs
  // which are fine settling once a day.
  await otaSyncQueue.add(
    "tick",
    {},
    { repeat: { pattern: process.env.OTA_CALENDAR_SYNC_CRON ?? "0 * * * *" }, jobId: "ota-calendar-sync-hourly" },
  );
  // Monthly, 1st-of-month — RentOS's own SaaS billing run.
  // generateMonthlyPlatformInvoices is idempotent per (tenant, year,
  // month), so a redeploy that re-registers this repeatable job mid-month
  // can't double-bill.
  await platformBillingQueue.add(
    "tick",
    {},
    { repeat: { pattern: process.env.PLATFORM_BILLING_CRON ?? "0 4 1 * *" }, jobId: "platform-billing-monthly" },
  );

  await invoiceQueue.close();
  await scheduledIssueQueue.close();
  await termLifecycleQueue.close();
  await dunningQueue.close();
  await ledgerQueue.close();
  await renewalOfferQueue.close();
  await renewalTimeoutQueue.close();
  await waitlistExpiryQueue.close();
  await otaSyncQueue.close();
  await platformBillingQueue.close();
}

export function startWorkers(connection: IORedis): Worker[] {
  const simpleWorker = (queue: string, run: () => Promise<void>) =>
    new Worker(
      queue,
      async (job: Job) => {
        console.log(`[${queue}] tick started (job ${job.id})`);
        await run();
        console.log(`[${queue}] tick completed`);
      },
      { connection },
    );

  const invoiceWorker = simpleWorker(INVOICE_GENERATION_QUEUE, runGenerateRecurringInvoices);
  const scheduledIssueWorker = simpleWorker(SCHEDULED_INVOICE_ISSUE_QUEUE, runIssueScheduledInvoices);
  const termLifecycleWorker = simpleWorker(TERM_LIFECYCLE_QUEUE, runTermLifecycle);
  const dunningWorker = simpleWorker(DUNNING_LADDER_QUEUE, runDunningLadder);
  const ledgerWorker = simpleWorker(LEDGER_BALANCE_CHECK_QUEUE, runLedgerBalanceCheck);
  const renewalOfferWorker = simpleWorker(RENEWAL_OFFER_QUEUE, runRenewalOffers);
  const renewalTimeoutWorker = simpleWorker(RENEWAL_TIMEOUT_QUEUE, runRenewalTimeouts);
  const waitlistExpiryWorker = simpleWorker(WAITLIST_EXPIRY_QUEUE, runWaitlistExpiry);
  const otaSyncWorker = simpleWorker(OTA_CALENDAR_SYNC_QUEUE, runSyncOtaCalendars);
  const platformBillingWorker = simpleWorker(PLATFORM_BILLING_QUEUE, runPlatformBilling);

  // Not a simpleWorker: this one is per-delivery rather than a cron tick, and
  // needs its own "failed" handler to flip a delivery to terminal FAILED once
  // BullMQ's retries are exhausted.
  const webhookDeliveryWorker = new Worker<WebhookDeliveryJobPayload>(
    TENANT_WEBHOOK_DELIVERY_QUEUE,
    async (job: Job<WebhookDeliveryJobPayload>) => {
      await deliverTenantWebhook(job.data, job.attemptsMade + 1);
    },
    { connection },
  );
  webhookDeliveryWorker.on("failed", async (job, err) => {
    console.error(`Job ${job?.id} in ${job?.queueName} failed:`, err);
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await markWebhookDeliveryFailed(job.data, err.message).catch((markErr) =>
        console.error(`Failed to mark delivery ${job.data.deliveryId} permanently FAILED:`, markErr),
      );
    }
  });

  const workers = [
    invoiceWorker,
    scheduledIssueWorker,
    termLifecycleWorker,
    dunningWorker,
    ledgerWorker,
    renewalOfferWorker,
    renewalTimeoutWorker,
    waitlistExpiryWorker,
    otaSyncWorker,
    platformBillingWorker,
  ];
  for (const worker of workers) {
    worker.on("failed", (job, err) => console.error(`Job ${job?.id} in ${job?.queueName} failed:`, err));
  }

  return [...workers, webhookDeliveryWorker];
}
