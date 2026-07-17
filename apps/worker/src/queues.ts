import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";

import { runDunningLadder } from "./jobs/dunning-ladder.job.js";
import { runGenerateRecurringInvoices } from "./jobs/generate-recurring-invoices.job.js";
import { runLedgerBalanceCheck } from "./jobs/ledger-balance-check.job.js";

export const INVOICE_GENERATION_QUEUE = "invoice-generation";
export const DUNNING_LADDER_QUEUE = "dunning-ladder";
export const LEDGER_BALANCE_CHECK_QUEUE = "ledger-balance-check";

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

  await invoiceQueue.close();
  await dunningQueue.close();
  await ledgerQueue.close();
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

  for (const worker of [invoiceWorker, dunningWorker, ledgerWorker]) {
    worker.on("failed", (job, err) => console.error(`Job ${job?.id} in ${job?.queueName} failed:`, err));
  }

  return [invoiceWorker, dunningWorker, ledgerWorker];
}
