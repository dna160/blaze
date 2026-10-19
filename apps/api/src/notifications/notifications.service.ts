import { Inject, Injectable, Logger } from "@nestjs/common";
import { findOrCreateCustomerAccessToken, resolveMessagingConfig, type ResolvedMessagingConfig } from "@rentos/database";
import { buildMagicLinkUrl, renderMessage } from "@rentos/domain";

import { RedisService } from "../common/redis/redis.service.js";
import { PrismaService } from "../prisma/prisma.service.js";

import { EMAIL_PROVIDER, type EmailProvider } from "./email-provider.interface.js";
import { MESSAGING_PROVIDERS, type MessagingProviderRegistry } from "./messaging-provider.interface.js";
import { WhatsAppSendError } from "./providers/whatsapp-send-error.js";

/**
 * How long a tenant's WhatsApp channel stays marked degraded after a failure
 * that affects every recipient. Short on purpose: it expires on its own, so a
 * template Meta approves or a token someone rotates heals without anyone
 * clearing a flag, and the worst case is one more failed send after it lapses.
 */
const CHANNEL_DEGRADED_TTL_SECONDS = 5 * 60;

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
    @Inject(MESSAGING_PROVIDERS) private readonly providers: MessagingProviderRegistry,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    private readonly redis: RedisService,
  ) {}

  private channelDegradedKey(tenantId: string): string {
    return `wa-degraded:${tenantId}`;
  }

  /**
   * Whether this tenant's WhatsApp channel is known to be refusing everything.
   *
   * Set by any send that fails channel-wide, read by callers for whom the
   * message IS the feature rather than a courtesy — sign-in, above all. That
   * split is deliberate: a booking confirmation must never fail because
   * WhatsApp is down (the booking is the valuable thing and it is already
   * saved), but a sign-in link that cannot be delivered is a sign-in that
   * cannot happen, and the customer deserves to be told rather than left on a
   * "check WhatsApp" screen forever.
   *
   * The useful consequence of putting the flag here rather than in the auth
   * code: the first casualty is usually a booking notification, so by the time
   * someone tries to sign in, the lifecycle send has already taught this method
   * the answer.
   */
  async isChannelDegraded(tenantId: string): Promise<boolean> {
    try {
      return (await this.redis.client.exists(this.channelDegradedKey(tenantId))) === 1;
    } catch (err) {
      // Redis being unreachable must not take sign-in down with it. Assume the
      // channel is fine and let the send attempt be the thing that fails.
      this.logger.warn(`Could not read the WhatsApp channel flag for ${tenantId}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Record that nothing is sending for this tenant. Only called for refusals
   * WhatsAppSendError classes as channel-wide — a recipient-specific refusal
   * (not in the allow-list, number undeliverable) must never lock out everyone
   * else.
   */
  private async markChannelDegraded(tenantId: string, err: WhatsAppSendError): Promise<void> {
    this.logger.error(
      `WhatsApp is refusing every send for tenant ${tenantId} (code ${err.code}${err.subcode !== null ? `/${err.subcode}` : ""}). ` +
        `Sign-in by WhatsApp will report itself unavailable for the next ${CHANNEL_DEGRADED_TTL_SECONDS / 60} minutes. ` +
        `Check Console → Settings → Messaging and the template's status in WhatsApp Manager.`,
    );
    try {
      await this.redis.client.set(
        this.channelDegradedKey(tenantId),
        String(err.code ?? err.status),
        "EX",
        CHANNEL_DEGRADED_TTL_SECONDS,
      );
    } catch (redisErr) {
      this.logger.warn(`Could not set the WhatsApp channel flag for ${tenantId}: ${(redisErr as Error).message}`);
    }
  }

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
    // Always set, never conditional: a WhatsApp template's parameter count is
    // fixed at registration, so letting this depend on whether the customer
    // gave a name made the same template send 3 parameters for one customer and
    // 4 for the next — one of which Meta always rejects.
    if (!variables.customerName) variables.customerName = customer.fullName ?? "Pelanggan";
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
          : await this.sendWhatsApp(params.tenantId, {
              to: params.recipient,
              templateKey: params.templateKey,
              variables: params.variables,
            });
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
      // Still swallowed, for the reason in the class comment: the caller's work
      // is done and saved, and a message is not worth losing a booking over.
      // What changed is that a failure affecting everyone now leaves a mark, so
      // the paths that cannot tolerate silence can see it.
      if (err instanceof WhatsAppSendError && err.isChannelWide) {
        await this.markChannelDegraded(params.tenantId, err);
      }
    }
  }

  /** Resolves the org's configured adapter (#40) and sends through it. */
  private async sendWhatsApp(tenantId: string, params: { to: string; templateKey: string; variables: Record<string, string> }) {
    const config = await resolveMessagingConfig(this.prisma.raw, tenantId);
    return this.providers[config.provider].send(params, config);
  }

  /**
   * Console "send a test message" — sends through an EXPLICIT config rather
   * than the saved one, so staff can prove a credential works before saving
   * it. Deliberately not persisted as a Notification: it belongs to no
   * customer and would pollute the message trail.
   */
  async sendTestMessage(config: ResolvedMessagingConfig, to: string, templateKey: string, variables: Record<string, string>) {
    return this.providers[config.provider].send({ to, templateKey, variables }, config);
  }

  /** Public so other modules (e.g. the console "copy KYC link" action) can mint a link without sending a message. */
  async mintMagicLink(
    tenantId: string,
    tenantSlug: string,
    customerId: string,
    purpose: string,
    next: string,
    ttlDays?: number,
  ): Promise<string> {
    const { token } = await this.prisma.runInTenantContext(tenantId, (tx) =>
      // Omitted, the shared default applies: a link in a booking message stays
      // usable for the life of that message. Sign-in links pass a short one.
      ttlDays === undefined
        ? findOrCreateCustomerAccessToken(tx, tenantId, customerId, purpose)
        : findOrCreateCustomerAccessToken(tx, tenantId, customerId, purpose, ttlDays),
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
