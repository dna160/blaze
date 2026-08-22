import { Inject, Injectable, Logger } from "@nestjs/common";
import { findOrCreateCustomerAccessToken } from "@rentos/database";
import { buildMagicLinkUrl, renderMessage } from "@rentos/domain";

import { PrismaService } from "../prisma/prisma.service.js";

import { EMAIL_PROVIDER, type EmailProvider } from "./email-provider.interface.js";
import { MESSAGING_PROVIDER, type MessagingProvider } from "./messaging-provider.interface.js";

export interface NotifyParams {
  tenantId: string;
  customerId?: string;
  channel: "WHATSAPP" | "EMAIL";
  templateKey: string;
  recipient: string;
  variables: Record<string, string>;
}

/** The subset of Customer the router needs — passed in so callers that already loaded the row don't re-query. */
export interface NotifiableCustomer {
  id: string;
  phone: string | null;
  email: string | null;
  fullName?: string | null;
  preferredChannel: "WHATSAPP" | "EMAIL";
}

export interface NotifyCustomerParams {
  tenantId: string;
  /** Used to build the magic link's base URL (tenant's primary domain, else STOREFRONT_BASE_URL). */
  tenantSlug: string;
  customer: NotifiableCustomer;
  templateKey: string;
  variables: Record<string, string>;
  /** PRD v2 §9 — when set, a magic link to `next` is minted and injected as `variables.link`. */
  link?: { purpose: string; next: string };
}

/**
 * Every outbound customer message is persisted to `notifications` first
 * (QUEUED), then sent — so a provider outage leaves an auditable trail of
 * what SHOULD have gone out, not silence (PRD §10 Reliability: dead-letter
 * queues for money-adjacent jobs; the same discipline applies to comms).
 *
 * PRD v2 D3: `notifyCustomer` routes by the customer's preferredChannel —
 * WhatsApp for phone/OTP customers, email for Google-signed-in ones — and
 * falls back to whichever contact detail actually exists. The lower-level
 * `notify` keeps its pre-v2 signature for the OTP path and any caller that
 * already knows the channel.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MESSAGING_PROVIDER) private readonly provider: MessagingProvider,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
  ) {}

  async notifyCustomer(params: NotifyCustomerParams): Promise<void> {
    const { customer } = params;
    const wantsEmail = customer.preferredChannel === "EMAIL";
    const channel: "WHATSAPP" | "EMAIL" = wantsEmail && customer.email ? "EMAIL" : !wantsEmail && customer.phone ? "WHATSAPP" : customer.email ? "EMAIL" : "WHATSAPP";
    const recipient = channel === "EMAIL" ? customer.email : customer.phone;
    if (!recipient) {
      this.logger.warn(`Customer ${customer.id} has neither phone nor email — ${params.templateKey} not sent.`);
      return;
    }

    const variables = { ...params.variables };
    if (!variables.customerName && customer.fullName) variables.customerName = customer.fullName;
    if (params.link) {
      variables.link = await this.mintMagicLink(params.tenantId, params.tenantSlug, customer.id, params.link.purpose, params.link.next);
    }

    await this.notify({ tenantId: params.tenantId, customerId: customer.id, channel, templateKey: params.templateKey, recipient, variables });
  }

  async notify(params: NotifyParams): Promise<void> {
    const record = await this.prisma.runInTenantContext(params.tenantId, (tx) =>
      tx.notification.create({
        data: {
          tenantId: params.tenantId,
          customerId: params.customerId,
          channel: params.channel,
          templateKey: params.templateKey,
          recipient: params.recipient,
          payload: params.variables,
          status: "QUEUED",
        },
      }),
    );

    try {
      const result =
        params.channel === "EMAIL"
          ? await this.email.send({ to: params.recipient, ...renderMessage(params.templateKey, params.variables) })
          : await this.provider.send({ to: params.recipient, templateKey: params.templateKey, variables: params.variables });
      await this.prisma.runInTenantContext(params.tenantId, (tx) =>
        tx.notification.update({
          where: { id: record.id },
          data: { status: "SENT", providerRef: result.providerRef, sentAt: new Date() },
        }),
      );
    } catch (err) {
      this.logger.error(`Notification ${record.id} failed to send: ${(err as Error).message}`);
      await this.prisma.runInTenantContext(params.tenantId, (tx) =>
        tx.notification.update({
          where: { id: record.id },
          data: { status: "FAILED", error: (err as Error).message },
        }),
      );
    }
  }

  /** Public so other modules (e.g. the console "copy KYC link" action) can mint a link without sending a message. */
  async mintMagicLink(tenantId: string, tenantSlug: string, customerId: string, purpose: string, next: string): Promise<string> {
    const { token } = await this.prisma.runInTenantContext(tenantId, (tx) =>
      findOrCreateCustomerAccessToken(tx, tenantId, customerId, purpose),
    );
    return buildMagicLinkUrl(await this.storefrontBaseUrl(tenantId, tenantSlug), token, next);
  }

  /**
   * The tenant's primary storefront domain (tenant_domains is excluded from
   * RLS — it's the public registry), else STOREFRONT_BASE_URL, else the
   * local dev default. A `.local`/`.test` domain is never used for links.
   */
  private async storefrontBaseUrl(tenantId: string, tenantSlug: string): Promise<string> {
    const envBase = process.env.STOREFRONT_BASE_URL;
    const primary = await this.prisma.raw.tenantDomain.findFirst({ where: { tenantId, isPrimary: true } });
    const domain = primary?.domain;
    if (domain && !/\.(local|test|localhost)$/.test(domain) && domain !== "localhost") {
      return `https://${domain}`;
    }
    if (envBase) return envBase.replace("{tenant}", tenantSlug);
    return "http://localhost:3000";
  }
}
