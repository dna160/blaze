import { createHmac } from "node:crypto";
import { getPrismaClient, withTenantContext } from "@rentos/database";

export interface WebhookDeliveryJobPayload {
  tenantId: string;
  deliveryId: string;
}

/**
 * Delivers exactly one TenantWebhookDelivery row, enqueued by apps/api's
 * WebhookDispatcherService.dispatch(). Unlike the cron-based jobs in this
 * directory, this one already knows its tenant from the job payload, so
 * it calls withTenantContext directly instead of looping over
 * prisma.tenant.findMany().
 *
 * On failure this throws, letting BullMQ's attempts/backoff (set at
 * enqueue time) retry — the delivery row stays PENDING with the latest
 * httpStatus/error recorded, and is only flipped to FAILED once retries
 * are exhausted (queues.ts's "failed" handler for this queue, which
 * checks job.attemptsMade === job.opts.attempts).
 */
export async function deliverTenantWebhook(payload: WebhookDeliveryJobPayload, attempt: number): Promise<void> {
  const prisma = getPrismaClient();

  const { delivery, subscription } = await withTenantContext(prisma, payload.tenantId, async (tx) => {
    const d = await tx.tenantWebhookDelivery.findUniqueOrThrow({ where: { id: payload.deliveryId } });
    const s = await tx.tenantWebhookSubscription.findUniqueOrThrow({ where: { id: d.subscriptionId } });
    return { delivery: d, subscription: s };
  });

  if (!subscription.isActive) {
    throw new Error("Subscription is no longer active.");
  }

  const envelope = {
    eventType: delivery.eventType,
    deliveryId: delivery.id,
    occurredAt: delivery.createdAt.toISOString(),
    data: delivery.payload,
  };
  const body = JSON.stringify(envelope);
  const signature = createHmac("sha256", subscription.secret).update(body).digest("hex");

  let httpStatus: number | null = null;
  let error: string | null = null;
  try {
    const response = await fetch(subscription.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rentos-signature": signature },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    httpStatus = response.status;
    if (!response.ok) error = `Receiver responded with HTTP ${response.status}`;
  } catch (err) {
    error = (err as Error).message;
  }

  const succeeded = httpStatus !== null && httpStatus >= 200 && httpStatus < 300;
  await withTenantContext(prisma, payload.tenantId, (tx) =>
    tx.tenantWebhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: succeeded ? "SUCCEEDED" : "PENDING",
        httpStatus,
        error,
        attempt,
        deliveredAt: succeeded ? new Date() : null,
      },
    }),
  );

  if (!succeeded) throw new Error(error ?? `Webhook delivery to ${subscription.url} failed.`);
}

/** Called once BullMQ's retries are exhausted — the terminal FAILED state (PENDING/SUCCEEDED/FAILED never re-attempt from here). */
export async function markWebhookDeliveryFailed(payload: WebhookDeliveryJobPayload, error: string): Promise<void> {
  const prisma = getPrismaClient();
  await withTenantContext(prisma, payload.tenantId, (tx) =>
    tx.tenantWebhookDelivery.update({
      where: { id: payload.deliveryId },
      data: { status: "FAILED", error },
    }),
  );
}
