import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHmac } from "node:crypto";

import { findOrganizationIdByPhoneNumberId, resolveAutoReply, resolveMessagingConfig, secretsMatch } from "@rentos/database";

import { MESSAGING_PROVIDERS, type MessagingProviderRegistry } from "./messaging-provider.interface.js";

import { PrismaService } from "../prisma/prisma.service.js";

/**
 * Meta's delivery-status and inbound-message webhook.
 *
 * Without this, a Notification row goes to SENT the moment the Graph API
 * ACCEPTS the call and never moves again — so a message Meta accepted and then
 * failed to deliver (number not on WhatsApp, outside the 24-hour window,
 * template paused mid-send) reads as delivered forever. Everything below exists
 * to close that gap; inbound replies are recorded on the same trail so a
 * customer answering "Waiting on customer reply" is not shouting into a void.
 */

/** Meta's status values, lowest to highest — a later webhook never downgrades an earlier one. */
const STATUS_RANK: Record<string, number> = { QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3 };

interface MetaStatus {
  id: string;
  status: string;
  recipient_id?: string;
  errors?: Array<{ code?: number; title?: string; message?: string; error_data?: { details?: string } }>;
}

interface MetaMessage {
  id: string;
  from: string;
  type: string;
  text?: { body: string };
  button?: { text?: string };
  interactive?: unknown;
}

interface MetaChangeValue {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  statuses?: MetaStatus[];
  messages?: MetaMessage[];
}

export interface WhatsAppWebhookPayload {
  object?: string;
  entry?: Array<{ id?: string; changes?: Array<{ field?: string; value?: MetaChangeValue }> }>;
}

@Injectable()
export class WhatsAppWebhookService {
  private readonly logger = new Logger("WhatsAppWebhook");

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MESSAGING_PROVIDERS) private readonly providers: MessagingProviderRegistry,
  ) {}

  /** Meta's GET handshake when the callback URL is first saved, and on every re-subscribe. */
  verifySubscription(mode: string | undefined, token: string | undefined, challenge: string | undefined): string | null {
    const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    if (!expected) {
      this.logger.error("WHATSAPP_WEBHOOK_VERIFY_TOKEN is unset — refusing to confirm the subscription.");
      return null;
    }
    if (mode !== "subscribe" || !token || !secretsMatch(token, expected)) return null;
    return challenge ?? "";
  }

  /**
   * `X-Hub-Signature-256` over the EXACT bytes Meta sent. Re-serialising the
   * parsed body would not reproduce them, which is why the controller hands us
   * `req.rawBody` and main.ts enables `rawBody`.
   *
   * Unset app secret = reject, not allow: an unauthenticated endpoint that
   * mutates notification state is worse than one that is temporarily down.
   */
  verifySignature(rawBody: Buffer | undefined, header: string | undefined): boolean {
    const secret = process.env.WHATSAPP_APP_SECRET;
    if (!secret) {
      this.logger.error("WHATSAPP_APP_SECRET is unset — rejecting the webhook delivery.");
      return false;
    }
    if (!rawBody || !header?.startsWith("sha256=")) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return secretsMatch(header.slice("sha256=".length), expected);
  }

  async handle(payload: WhatsAppWebhookPayload): Promise<void> {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;
        if (!value) continue;

        const phoneNumberId = value.metadata?.phone_number_id;
        if (!phoneNumberId) {
          this.logger.warn("Webhook change with no phone_number_id — cannot attribute it to an organization.");
          continue;
        }

        // Resolved once per change, not per status: Meta batches many receipts
        // into one delivery, and they all belong to the same number.
        const tenantIds = await this.tenantsForPhoneNumber(phoneNumberId);
        if (tenantIds.length === 0) {
          this.logger.warn(`No organization owns phone_number_id ${phoneNumberId} — is Console -> Settings -> Messaging saved?`);
          continue;
        }

        for (const status of value.statuses ?? []) await this.applyStatus(tenantIds, status);
        for (const message of value.messages ?? []) await this.recordInbound(tenantIds, message);
      }
    }
  }

  /**
   * The branches that share the number this webhook is about.
   *
   * This indirection is what makes the lookups below RLS-safe. The obvious
   * implementation — find the notification by provider ref in platform context —
   * silently finds nothing: `notifications` carries only `tenant_isolation` and
   * `org_read` policies, so `app.platform_admin` grants no visibility on it at
   * all. Rather than widen that table's RLS for a webhook, resolve the number to
   * its organization's branches and read each in its own tenant context.
   */
  private async tenantsForPhoneNumber(phoneNumberId: string): Promise<string[]> {
    const organizationId = await findOrganizationIdByPhoneNumberId(this.prisma.raw, phoneNumberId);
    if (!organizationId) return [];
    const tenants = await this.prisma.raw.tenant.findMany({ where: { organizationId }, select: { id: true } });
    return tenants.map((t) => t.id);
  }

  /**
   * Status receipts key off the Graph message id, which we already store as
   * `Notification.providerRef`. Searched per branch in tenant context — see
   * `tenantsForPhoneNumber` for why platform context cannot do this.
   */
  private async applyStatus(tenantIds: string[], status: MetaStatus): Promise<void> {
    const next = status.status?.toUpperCase();
    if (!status.id || !next) return;

    for (const tenantId of tenantIds) {
      const applied = await this.prisma.runInTenantContext(tenantId, async (tx) => {
        const existing = await tx.notification.findFirst({
          where: { providerRef: status.id },
          select: { id: true, status: true },
        });
        if (!existing) return false;

        if (next === "FAILED") {
          const first = status.errors?.[0];
          const detail = first?.error_data?.details ?? first?.message ?? first?.title ?? "Delivery failed at Meta.";
          await tx.notification.update({
            where: { id: existing.id },
            data: { status: "FAILED", error: `${first?.code ? `[${first.code}] ` : ""}${detail}`.slice(0, 500) },
          });
          return true;
        }

        // Meta does not guarantee ordering, so a late `delivered` must not undo a
        // `read` that already landed — and nothing climbs back out of FAILED.
        const currentRank = STATUS_RANK[existing.status];
        const nextRank = STATUS_RANK[next];
        if (currentRank === undefined || nextRank === undefined || nextRank <= currentRank) return true;
        await tx.notification.update({ where: { id: existing.id }, data: { status: next } });
        return true;
      });
      if (applied) return;
    }

    // Console test sends are deliberately not persisted, so their receipts have
    // nothing to attach to. Logged at info rather than debug: Nest is configured
    // for error/warn/log only, and a silent miss here is how a broken lookup
    // hides.
    this.logger.log(`No notification matches provider ref ${status.id} (${next}) — a console test send, or sent before this deploy.`);
  }

  /**
   * An inbound reply. Recorded on the existing notifications trail (status
   * RECEIVED) rather than in a new table: it keeps one chronological record per
   * customer, which is what the pipeline's "Waiting on customer reply" column
   * needs to read. Surfacing it in the console is a separate piece of work —
   * this only guarantees the message is not lost.
   */
  private async recordInbound(tenantIds: string[], message: MetaMessage): Promise<void> {
    const text = message.text?.body ?? message.button?.text ?? `(${message.type})`;

    // One organization is many branches; the reply belongs to whichever branch
    // knows this phone number. Meta strips the leading +, and customers are
    // stored with it, so both spellings are tried.
    const candidates = [message.from, `+${message.from.replace(/^\+/, "")}`];
    for (const tenantId of tenantIds) {
      const customer = await this.prisma.runInTenantContext(tenantId, (tx) =>
        tx.customer.findFirst({ where: { phone: { in: candidates } }, select: { id: true } }),
      );
      if (!customer) continue;
      const saved = await this.saveInbound(tenantId, customer.id, message, text);
      if (saved) await this.autoReply(tenantId, message.from);
      return;
    }

    // An unrecognised number still leaves a trail, on the organization's first
    // branch, rather than being dropped.
    const fallback = tenantIds[0];
    if (fallback) {
      const saved = await this.saveInbound(fallback, null, message, text);
      if (saved) await this.autoReply(fallback, message.from);
    }
  }

  /**
   * Reply to the customer, if the organization has an auto-reply configured.
   *
   * Free-form rather than a template, which is the whole point: WhatsApp allows
   * arbitrary text within 24 hours of the customer's own message, and we are
   * answering one right now, so this works before a single template has been
   * approved.
   *
   * Only fires for a message we actually recorded, so Meta's redeliveries do not
   * produce a reply each time. A failure here is logged and swallowed: an
   * unanswered message is better than a webhook that errors and gets retried
   * into a loop.
   */
  private async autoReply(tenantId: string, to: string): Promise<void> {
    try {
      const reply = await resolveAutoReply(this.prisma.raw, tenantId);
      if (!reply) return;

      const config = await resolveMessagingConfig(this.prisma.raw, tenantId);
      const result = await this.providers[config.provider].sendText({ to, text: reply.text }, config);

      await this.prisma.runInTenantContext(tenantId, (tx) =>
        tx.notification.create({
          data: {
            tenantId,
            channel: "WHATSAPP",
            templateKey: "auto_reply",
            recipientRole: "CUSTOMER",
            recipient: to,
            payload: { text: reply.text },
            status: "SENT",
            providerRef: result.providerRef,
            sentAt: new Date(),
          },
        }),
      );
    } catch (err) {
      this.logger.error(`Auto-reply to ${to} failed: ${(err as Error).message}`);
    }
  }

  /** Returns false when this message was already recorded, so callers can skip re-acting to a redelivery. */
  private async saveInbound(tenantId: string, customerId: string | null, message: MetaMessage, text: string): Promise<boolean> {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      // Meta retries a delivery it thinks failed, so the same message id can
      // arrive more than once.
      const seen = await tx.notification.findFirst({ where: { providerRef: message.id, templateKey: "inbound_message" } });
      if (seen) return false;
      await tx.notification.create({
        data: {
          tenantId,
          customerId: customerId ?? undefined,
          channel: "WHATSAPP",
          templateKey: "inbound_message",
          recipientRole: "CUSTOMER",
          recipient: message.from,
          payload: { text, waMessageType: message.type },
          status: "RECEIVED",
          providerRef: message.id,
          sentAt: new Date(),
        },
      });
      return true;
    });
  }
}
