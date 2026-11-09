import { Inject, Injectable, Logger } from "@nestjs/common";
import { createHmac } from "node:crypto";

import {
  claimAutoReply,
  contactKey,
  findOrganizationIdByPhoneNumberId,
  organizationSystemNumber,
  outboundBlock,
  recordSuppressed,
  releaseAutoReplyClaim,
  resolveAutoReply,
  resolveMessagingConfig,
  secretsMatch,
} from "@rentos/database";
import { renderAutoReply, type BranchContact } from "@rentos/domain";

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

/** The bridge's media kinds that map onto Meta's media message fields. */
const BRIDGE_MEDIA_TYPES = new Set(["image", "video", "document", "audio", "sticker"]);

/** Meta's status values, lowest to highest — a later webhook never downgrades an earlier one. */
const STATUS_RANK: Record<string, number> = { QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3 };

interface MetaStatus {
  id: string;
  status: string;
  recipient_id?: string;
  errors?: Array<{ code?: number; title?: string; message?: string; error_data?: { details?: string } }>;
}

interface MetaMedia {
  id?: string;
  caption?: string;
}

interface MetaMessage {
  id: string;
  from: string;
  type: string;
  text?: { body: string };
  button?: { text?: string };
  interactive?: unknown;
  image?: MetaMedia;
  document?: MetaMedia;
  audio?: MetaMedia;
  video?: MetaMedia;
  sticker?: MetaMedia;
}

/** Meta sends the sender's WhatsApp profile name alongside every inbound message. */
interface MetaContact {
  wa_id?: string;
  profile?: { name?: string };
}

interface MetaChangeValue {
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  statuses?: MetaStatus[];
  messages?: MetaMessage[];
  contacts?: MetaContact[];
}

/**
 * What apps/wa-bridge POSTs (the linked-device route). Same two facts as Meta's
 * payload — an inbound message or a delivery receipt — addressed by instance,
 * which is the organization id, instead of by phone_number_id.
 */
export type WaBridgeEvent =
  | {
      type: "message";
      instanceId: string;
      id: string;
      from: string;
      fromLid?: boolean;
      pushName?: string;
      timestamp: string;
      kind: string;
      text: string;
    }
  | { type: "receipt"; instanceId: string; ids: string[]; status: "DELIVERED" | "READ" }
  | { type: "connection"; instanceId: string; state: string; detail?: string };

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

  /**
   * The bridge signs with the shared WA_BRIDGE_TOKEN, HMAC-SHA256 over the raw
   * body, as `X-Bridge-Signature: sha256=<hex>` — the same shape as Meta's.
   */
  verifyBridgeSignature(rawBody: Buffer | undefined, header: string | undefined): boolean {
    const secret = process.env.WA_BRIDGE_TOKEN;
    if (!secret) {
      this.logger.error("WA_BRIDGE_TOKEN is unset — rejecting the bridge delivery.");
      return false;
    }
    if (!rawBody || !header?.startsWith("sha256=")) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    return secretsMatch(header.slice("sha256=".length), expected);
  }

  /**
   * Linked-device events, fed into the same status and inbound paths as Meta's
   * webhook so the inbox, receipts and auto-reply behave identically on both.
   * A database failure throws, so the bridge withholds WhatsApp's ack and the
   * message is redelivered; an unknown organization is logged and dropped,
   * because retrying cannot fix it.
   */
  async handleBridgeEvent(event: WaBridgeEvent): Promise<void> {
    if (event.type === "connection") {
      const line = `WhatsApp linked device for organization ${event.instanceId} is now ${event.state}${event.detail ? `: ${event.detail}` : ""}`;
      if (["logged_out", "replaced", "banned"].includes(event.state)) this.logger.error(line);
      else this.logger.log(line);
      return;
    }

    const tenants = await this.prisma.raw.tenant.findMany({ where: { organizationId: event.instanceId }, select: { id: true } });
    const tenantIds = tenants.map((t) => t.id);
    if (tenantIds.length === 0) {
      this.logger.warn(`Bridge event for unknown organization ${event.instanceId} — dropped.`);
      return;
    }

    if (event.type === "receipt") {
      for (const id of event.ids) await this.applyStatus(tenantIds, { id, status: event.status.toLowerCase() });
      return;
    }

    // Shaped like Meta's message so recordInbound and the inbox need no second
    // code path: media carries its caption, everything else is text.
    const type = event.kind === "voice" ? "audio" : event.kind;
    const message: MetaMessage = {
      id: event.id,
      from: event.from,
      type,
      ...(BRIDGE_MEDIA_TYPES.has(type)
        ? { [type]: event.text ? { caption: event.text } : {} }
        : { text: { body: event.text || `(${event.kind})` } }),
    };
    const contacts: MetaContact[] = event.pushName ? [{ wa_id: event.from, profile: { name: event.pushName } }] : [];
    await this.recordInbound(tenantIds, message, contacts);
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
        for (const message of value.messages ?? []) await this.recordInbound(tenantIds, message, value.contacts ?? []);
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
  private async recordInbound(tenantIds: string[], message: MetaMessage, contacts: MetaContact[]): Promise<void> {
    const text = message.text?.body ?? message.button?.text ?? `(${message.type})`;
    const profileName = contacts.find((c) => c.wa_id === message.from)?.profile?.name;

    // One organization is many branches; the reply belongs to whichever branch
    // knows this phone number. Meta strips the leading +, and customers are
    // stored with it, so both spellings are tried.
    const candidates = [message.from, `+${message.from.replace(/^\+/, "")}`];
    // Every branch that knows this number — the auto-reply points a customer
    // of exactly one branch at that branch's CS (PRD go-live §9.4).
    const matches: Array<{ tenantId: string; customerId: string }> = [];
    for (const tenantId of tenantIds) {
      const customer = await this.prisma.runInTenantContext(tenantId, (tx) =>
        tx.customer.findFirst({ where: { phone: { in: candidates } }, select: { id: true } }),
      );
      if (customer) matches.push({ tenantId, customerId: customer.id });
    }

    // The message is recorded once, on the first branch that knows the number;
    // an unrecognised number still leaves a trail on the organization's first
    // branch rather than being dropped.
    const home = matches[0] ?? (tenantIds[0] ? { tenantId: tenantIds[0], customerId: null } : null);
    if (!home) return;
    const saved = await this.saveInbound(home.tenantId, home.customerId, message, text, profileName);
    if (saved) await this.autoReply(home.tenantId, message.from, tenantIds, matches.length === 1 ? matches[0]!.tenantId : null);
  }

  /**
   * Reply to the customer, if the organization has an auto-reply configured.
   *
   * Free-form rather than a template, which is the whole point: WhatsApp allows
   * arbitrary text within 24 hours of the customer's own message, and we are
   * answering one right now, so this works before a single template has been
   * approved.
   *
   * PRD go-live §9.2 — at most once per number per cooldown (default 12h), and
   * not at all while a human answered within that cooldown. The claim is one
   * atomic statement, so three messages inside a minute produce one reply even
   * when their webhooks race. Outbound echoes (messages the number's owner
   * typed on the phone) never get here: the bridge drops IsFromMe, and Meta
   * reports our own sends as statuses, not messages.
   *
   * PRD go-live §9.1 — while messaging is paused the reply is recorded as
   * SUPPRESSED instead of sent.
   *
   * Only fires for a message we actually recorded, so redeliveries do not
   * produce a reply each time. A failure here is logged and swallowed: an
   * unanswered message is better than a webhook that errors and gets retried
   * into a loop.
   */
  private async autoReply(tenantId: string, to: string, orgTenantIds: string[], soleBranchTenantId: string | null): Promise<void> {
    try {
      const reply = await resolveAutoReply(this.prisma.raw, tenantId);
      if (!reply) return;

      if (!(await claimAutoReply(this.prisma.raw, reply.organizationId, to, reply.cooldownHours))) {
        this.logger.log(`Auto-reply to ${to} skipped — within the ${reply.cooldownHours}h cooldown or a person replied recently.`);
        return;
      }

      const text = await this.renderAutoReplyText(reply.text, orgTenantIds, soleBranchTenantId);

      const blocked = await outboundBlock(this.prisma.raw, tenantId);
      if (blocked) {
        await this.prisma.runInTenantContext(tenantId, (tx) =>
          recordSuppressed(tx, { tenantId, channel: "WHATSAPP", templateKey: "auto_reply", recipient: to, payload: { text }, reason: blocked }),
        );
        return;
      }

      const config = await resolveMessagingConfig(this.prisma.raw, tenantId);
      let result;
      try {
        result = await this.providers[config.provider].sendText({ to, text }, config);
      } catch (err) {
        // Give the slot back so the customer's next message can be answered.
        await releaseAutoReplyClaim(this.prisma.raw, reply.organizationId, to);
        throw err;
      }

      await this.prisma.runInTenantContext(tenantId, (tx) =>
        tx.notification.create({
          data: {
            tenantId,
            channel: "WHATSAPP",
            templateKey: "auto_reply",
            recipientRole: "CUSTOMER",
            recipient: to,
            payload: { text },
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

  /** PRD go-live §9.4 — fill {branchName}/{branchWhatsapp}/{branchPhone}/{allBranches} from Settings → Branch. */
  private async renderAutoReplyText(template: string, orgTenantIds: string[], soleBranchTenantId: string | null): Promise<string> {
    const tenants = await this.prisma.raw.tenant.findMany({
      where: { id: { in: orgTenantIds } },
      select: { id: true, name: true, contact: true, organizationId: true },
      orderBy: { name: "asc" },
    });
    // The reply is sent FROM the system number; never tell anyone to contact it.
    const system = tenants[0] ? await organizationSystemNumber(this.prisma.raw, tenants[0].organizationId) : null;
    const branches: BranchContact[] = tenants.map((t) => {
      const c = (t.contact ?? {}) as { whatsapp?: string; whatsappDisplay?: string; phone?: string; email?: string };
      const isSystem = Boolean(system && c.whatsapp && contactKey(c.whatsapp) === system);
      return {
        id: t.id,
        name: t.name,
        whatsapp: isSystem ? null : (c.whatsappDisplay ?? c.whatsapp ?? null),
        phone: c.phone ?? null,
        email: c.email ?? null,
      };
    });
    return renderAutoReply(template, branches, soleBranchTenantId);
  }

  /** The attachment id and caption for a media message, so the inbox can label it. Downloading is out of scope. */
  private mediaOf(message: MetaMessage): { mediaId?: string; caption?: string } {
    const media = message.image ?? message.document ?? message.audio ?? message.video ?? message.sticker;
    if (!media) return {};
    return { ...(media.id ? { mediaId: media.id } : {}), ...(media.caption ? { caption: media.caption } : {}) };
  }

  /** Returns false when this message was already recorded, so callers can skip re-acting to a redelivery. */
  private async saveInbound(
    tenantId: string,
    customerId: string | null,
    message: MetaMessage,
    text: string,
    profileName?: string,
  ): Promise<boolean> {
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
          payload: {
            text,
            waMessageType: message.type,
            ...(profileName ? { profileName } : {}),
            ...this.mediaOf(message),
          },
          status: "RECEIVED",
          providerRef: message.id,
          sentAt: new Date(),
        },
      });
      return true;
    });
  }
}
