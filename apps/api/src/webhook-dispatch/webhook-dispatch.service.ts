import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import type { WebhookEventType } from "@rentos/contracts";
import type { Prisma } from "@rentos/database";

import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

export const TENANT_WEBHOOK_DELIVERY_QUEUE = "tenant-webhook-delivery";

export interface WebhookDeliveryJob {
  tenantId: string;
  deliveryId: string;
}

/**
 * Fires PRD Phase-4 outbound webhooks (booking.approved, invoice.paid,
 * payment.received — see @rentos/contracts WEBHOOK_EVENT_TYPES). Callers
 * (BookingService, PaymentsService) call dispatch() unconditionally at the
 * point an event actually happens; this is a silent no-op whenever the
 * tenant lacks featureFlags.api_access_enabled or has no active matching
 * subscription, so it never needs its own gating logic at every call site.
 *
 * Uses a dedicated IORedis connection (maxRetriesPerRequest: null, as
 * BullMQ requires) rather than the existing RedisService, which is tuned
 * for the unrelated OTP-storage use case (maxRetriesPerRequest: 3).
 */
@Injectable()
export class WebhookDispatcherService implements OnModuleDestroy {
  private readonly logger = new Logger(WebhookDispatcherService.name);
  private readonly connection: IORedis;
  private readonly queue: Queue<WebhookDeliveryJob>;

  constructor(private readonly prisma: PrismaService) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set.");
    this.connection = new IORedis(url, { maxRetriesPerRequest: null });
    this.queue = new Queue<WebhookDeliveryJob>(TENANT_WEBHOOK_DELIVERY_QUEUE, { connection: this.connection });
  }

  async dispatch(tenant: ResolvedTenant, eventType: WebhookEventType, data: Record<string, unknown>): Promise<void> {
    if (!tenant.featureFlags.api_access_enabled) return;

    const subscriptions = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.tenantWebhookSubscription.findMany({
        where: { isActive: true, eventTypes: { has: eventType } },
      }),
    );
    if (subscriptions.length === 0) return;

    for (const subscription of subscriptions) {
      const delivery = await this.prisma.runInTenantContext(tenant.id, (tx) =>
        tx.tenantWebhookDelivery.create({
          data: { tenantId: tenant.id, subscriptionId: subscription.id, eventType, payload: data as Prisma.InputJsonValue },
        }),
      );
      await this.queue.add(
        "deliver",
        { tenantId: tenant.id, deliveryId: delivery.id },
        { attempts: 5, backoff: { type: "exponential", delay: 30_000 } },
      );
      this.logger.log(`Enqueued ${eventType} delivery ${delivery.id} for subscription ${subscription.id}`);
    }
  }

  async onModuleDestroy() {
    await this.queue.close();
    await this.connection.quit();
  }
}
