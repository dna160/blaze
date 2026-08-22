import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";

import { deliverTenantWebhook, markWebhookDeliveryFailed, type WebhookDeliveryJobPayload } from "./jobs/deliver-tenant-webhook.job.js";
import { runDunningLadder } from "./jobs/dunning-ladder.job.js";
import { runGenerateRecurringInvoices } from "./jobs/generate-recurring-invoices.job.js";
import { runIssueScheduledInvoices } from "./jobs/issue-scheduled-invoices.job.js";
import { runLedgerBalanceCheck } from "./jobs/ledger-balance-check.job.js";
import { runTermLifecycle } from "./jobs/term-lifecycle.job.js";
import { runPlatformBilling } from "./jobs/platform-billing.job.js";
import { runSyncOtaCalendars } from "./jobs/sync-ota-calendars.job.js";

export const INVOICE_GENERATION_QUEUE = "invoice-generation";
/** PRD v2 §8 — issues the SCHEDULED cycles of term payment schedules on their issue date. */
export const SCHEDULED_INVOICE_ISSUE_QUEUE = "scheduled-invoice-issue";
/** PRD v2 P6 — expires stale requests, ends terms, applies notice dates. */
export const TERM_LIFECYCLE_QUEUE = "term-lifecycle";
export const DUNNING_LADDER_QUEUE = "dunning-ladder";
export const LEDGER_BALANCE_CHECK_QUEUE = "ledger-balance-check";
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
 * All three jobs run daily (PRD §8.2: "Recurring generator runs daily";
 * §7.2.4 dunning ladder; §10 "double-entry ledger balances checked
 * nightly"). Registered as BullMQ repeatable jobs rather than a plain
 * setInterval so retries, concurrency, and observability come from the
 * same queue infra as everything else in the stack (PRD §11: "BullMQ
 * workers (invoicing, dunning, webhooks)").
 */
export async function scheduleRepeatableJobs(connection: IORedis): Promise<void> {
  const invoiceQueue = new Queue(INVOICE_GENERATION_QUEUE, { connection });
  const dunningQueue = new Queue(DUNNING_LADDER_QUEUE, { connection });
  const ledgerQueue = new Queue(LEDGER_BALANCE_CHECK_QUEUE, { connection });
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
  // Hourly, not daily — OTA availability changes throughout the day and a
  // stale block window risks a real double-booking, unlike the other
  // three jobs which are fine settling once a day.
  await otaSyncQueue.add(
    "tick",
    {},
    { repeat: { pattern: process.env.OTA_CALENDAR_SYNC_CRON ?? "0 * * * *" }, jobId: "ota-calendar-sync-hourly" },
  );
  // Monthly, 1st-of-month — RentOS's own SaaS billing run (Session 26).
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
  await otaSyncQueue.close();
  await platformBillingQueue.close();
}

export function startWorkers(connection: IORedis): Worker[] {
  const invoiceWorker = new Worker(
    INVOICE_GENERATION_QUEUE,
    async (job: Job) => {
      console.log(`[${INVOICE_GENERATION_QUEUE}] tick started (job ${job.id})`);
      await runGenerateRecurringInvoices();
      console.log(`[${INVOICE_GENERATION_QUEUE}] tick completed`);
    },
    { connection },
  );

  const scheduledIssueWorker = new Worker(
    SCHEDULED_INVOICE_ISSUE_QUEUE,
    async (job: Job) => {
      console.log(`[${SCHEDULED_INVOICE_ISSUE_QUEUE}] tick started (job ${job.id})`);
      await runIssueScheduledInvoices();
      console.log(`[${SCHEDULED_INVOICE_ISSUE_QUEUE}] tick completed`);
    },
    { connection },
  );

  const termLifecycleWorker = new Worker(
    TERM_LIFECYCLE_QUEUE,
    async (job: Job) => {
      console.log(`[${TERM_LIFECYCLE_QUEUE}] tick started (job ${job.id})`);
      await runTermLifecycle();
      console.log(`[${TERM_LIFECYCLE_QUEUE}] tick completed`);
    },
    { connection },
  );

  const dunningWorker = new Worker(
    DUNNING_LADDER_QUEUE,
    async (job: Job) => {
      console.log(`[${DUNNING_LADDER_QUEUE}] tick started (job ${job.id})`);
      await runDunningLadder();
      console.log(`[${DUNNING_LADDER_QUEUE}] tick completed`);
    },
    { connection },
  );

  const ledgerWorker = new Worker(
    LEDGER_BALANCE_CHECK_QUEUE,
    async (job: Job) => {
      console.log(`[${LEDGER_BALANCE_CHECK_QUEUE}] tick started (job ${job.id})`);
      await runLedgerBalanceCheck();
      console.log(`[${LEDGER_BALANCE_CHECK_QUEUE}] tick completed`);
    },
    { connection },
  );

  const otaSyncWorker = new Worker(
    OTA_CALENDAR_SYNC_QUEUE,
    async (job: Job) => {
      console.log(`[${OTA_CALENDAR_SYNC_QUEUE}] tick started (job ${job.id})`);
      await runSyncOtaCalendars();
      console.log(`[${OTA_CALENDAR_SYNC_QUEUE}] tick completed`);
    },
    { connection },
  );

  const platformBillingWorker = new Worker(
    PLATFORM_BILLING_QUEUE,
    async (job: Job) => {
      console.log(`[${PLATFORM_BILLING_QUEUE}] tick started (job ${job.id})`);
      await runPlatformBilling();
      console.log(`[${PLATFORM_BILLING_QUEUE}] tick completed`);
    },
    { connection },
  );

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

  for (const worker of [invoiceWorker, scheduledIssueWorker, termLifecycleWorker, dunningWorker, ledgerWorker, otaSyncWorker, platformBillingWorker]) {
    worker.on("failed", (job, err) => console.error(`Job ${job?.id} in ${job?.queueName} failed:`, err));
  }

  return [invoiceWorker, scheduledIssueWorker, termLifecycleWorker, dunningWorker, ledgerWorker, otaSyncWorker, platformBillingWorker, webhookDeliveryWorker];
}
