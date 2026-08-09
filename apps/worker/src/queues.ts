import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";

import { runDunningLadder } from "./jobs/dunning-ladder.job.js";
import { runGenerateRecurringInvoices } from "./jobs/generate-recurring-invoices.job.js";
import { runLedgerBalanceCheck } from "./jobs/ledger-balance-check.job.js";
import { runRenewalOffers } from "./jobs/renewal-offer.job.js";
import { runRenewalTimeouts } from "./jobs/renewal-timeout.job.js";
import { runWaitlistExpiry } from "./jobs/waitlist-expiry.job.js";

export const INVOICE_GENERATION_QUEUE = "invoice-generation";
export const DUNNING_LADDER_QUEUE = "dunning-ladder";
export const LEDGER_BALANCE_CHECK_QUEUE = "ledger-balance-check";
export const RENEWAL_OFFER_QUEUE = "renewal-offer";
export const RENEWAL_TIMEOUT_QUEUE = "renewal-timeout";
export const WAITLIST_EXPIRY_QUEUE = "waitlist-expiry";

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
  const renewalOfferQueue = new Queue(RENEWAL_OFFER_QUEUE, { connection });
  const renewalTimeoutQueue = new Queue(RENEWAL_TIMEOUT_QUEUE, { connection });
  const waitlistExpiryQueue = new Queue(WAITLIST_EXPIRY_QUEUE, { connection });

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

  await invoiceQueue.close();
  await dunningQueue.close();
  await ledgerQueue.close();
  await renewalOfferQueue.close();
  await renewalTimeoutQueue.close();
  await waitlistExpiryQueue.close();
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

  const renewalOfferWorker = simpleWorker(RENEWAL_OFFER_QUEUE, runRenewalOffers);
  const renewalTimeoutWorker = simpleWorker(RENEWAL_TIMEOUT_QUEUE, runRenewalTimeouts);
  const waitlistExpiryWorker = simpleWorker(WAITLIST_EXPIRY_QUEUE, runWaitlistExpiry);

  const workers = [invoiceWorker, dunningWorker, ledgerWorker, renewalOfferWorker, renewalTimeoutWorker, waitlistExpiryWorker];
  for (const worker of workers) {
    worker.on("failed", (job, err) => console.error(`Job ${job?.id} in ${job?.queueName} failed:`, err));
  }

  return workers;
}
