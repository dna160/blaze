import { randomBytes } from "node:crypto";
import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { UpdateWebhookSubscriptionRequest } from "@rentos/contracts";

import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

const LIST_SELECT = { id: true, url: true, eventTypes: true, isActive: true, createdAt: true } as const;

function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString("base64url")}`;
}

/**
 * Console-facing CRUD for TenantWebhookSubscription. Unlike TenantApiKey,
 * the signing secret IS stored in plaintext (apps/worker's delivery job
 * needs it to compute the HMAC on every delivery), so it could technically
 * be re-shown later — but the list/get responses omit it by convention
 * (same "shown once, at creation" UX as Stripe/GitHub webhook secrets) to
 * minimize exposure surface.
 */
@Injectable()
export class TenantWebhooksService {
  constructor(private readonly prisma: PrismaService) {}

  async create(tenant: ResolvedTenant, createdByUserId: string, url: string, eventTypes: string[]) {
    this.assertEnabled(tenant);
    const secret = generateWebhookSecret();
    const record = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.tenantWebhookSubscription.create({ data: { tenantId: tenant.id, url, secret, eventTypes, createdByUserId } }),
    );
    return { ...record, secret };
  }

  list(tenant: ResolvedTenant) {
    this.assertEnabled(tenant);
    return this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.tenantWebhookSubscription.findMany({ select: LIST_SELECT, orderBy: { createdAt: "desc" } }),
    );
  }

  async update(tenant: ResolvedTenant, id: string, patch: UpdateWebhookSubscriptionRequest) {
    this.assertEnabled(tenant);
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const existing = await tx.tenantWebhookSubscription.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException("Webhook subscription not found.");
      return tx.tenantWebhookSubscription.update({ where: { id }, data: patch, select: LIST_SELECT });
    });
  }

  async remove(tenant: ResolvedTenant, id: string) {
    this.assertEnabled(tenant);
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const existing = await tx.tenantWebhookSubscription.findUnique({ where: { id } });
      if (!existing) throw new NotFoundException("Webhook subscription not found.");
      await tx.tenantWebhookSubscription.delete({ where: { id } });
      return { status: "deleted" };
    });
  }

  async listDeliveries(tenant: ResolvedTenant, subscriptionId: string) {
    this.assertEnabled(tenant);
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const subscription = await tx.tenantWebhookSubscription.findUnique({ where: { id: subscriptionId } });
      if (!subscription) throw new NotFoundException("Webhook subscription not found.");
      return tx.tenantWebhookDelivery.findMany({
        where: { subscriptionId },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
    });
  }

  private assertEnabled(tenant: ResolvedTenant) {
    if (!tenant.featureFlags.api_access_enabled) {
      throw new ForbiddenException("External API access is not enabled for this tenant.");
    }
  }
}
