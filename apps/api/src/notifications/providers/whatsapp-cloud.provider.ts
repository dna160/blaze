import { Injectable, Logger } from "@nestjs/common";
import type { ResolvedMessagingConfig } from "@rentos/database";
import { buildWhatsAppTemplatePayload } from "@rentos/domain";

import type {
  MessagingProvider,
  SendTemplateMessageParams,
  SendTextMessageParams,
  SendTemplateMessageResult,
} from "../messaging-provider.interface.js";

/**
 * Meta WhatsApp Cloud API adapter (PRD §7.1.5, §11 MessagingProvider port).
 *
 * Stateless: the phone number and access token come from the resolved config
 * for the organization this message belongs to (#40), not from the process
 * environment, so one deployment serves many orgs' numbers and the console's
 * "send a test" can pass credentials that are not saved yet.
 */
@Injectable()
export class WhatsAppCloudMessagingProvider implements MessagingProvider {
  readonly name = "WHATSAPP_CLOUD";
  private readonly logger = new Logger("MessagingProvider");
  /**
   * Overridable so a sandbox or an integration test can point at a stub, and so
   * the Graph version can be pinned without a code change. Defaults to the real
   * endpoint, so an unset variable behaves exactly as before.
   */
  private readonly apiBase = process.env.WHATSAPP_GRAPH_BASE_URL ?? "https://graph.facebook.com/v21.0";

  async send(params: SendTemplateMessageParams, config: ResolvedMessagingConfig): Promise<SendTemplateMessageResult> {
    const creds = config.whatsapp;
    if (!creds?.accessToken || !creds.phoneNumberId) {
      throw new Error(
        "WhatsApp Cloud is selected but no phone number ID / access token is configured — " +
          "set them in Console → Settings → Messaging, or switch the provider back to console_log.",
      );
    }

    // Wire format comes from the shared registry, not from this call's variable
    // insertion order — see packages/domain/src/comms/whatsapp-templates.ts for
    // why that distinction is a correctness one.
    const payload = buildWhatsAppTemplatePayload(params.templateKey, params.to, params.variables);

    const response = await fetch(`${this.apiBase}/${creds.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text();
      // Meta echoes the request back on some errors; never log the auth header.
      this.logger.error(`WhatsApp Cloud API error ${response.status}: ${body}`);
      throw new Error(`WhatsApp Cloud API error ${response.status}: ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as { messages?: Array<{ id: string }> };
    return { providerRef: json.messages?.[0]?.id ?? "unknown" };
  }

  /**
   * Free-form text. Needs no registered template, because WhatsApp allows it
   * inside the 24-hour window opened by the customer's own message — which is
   * why replying to an inbound works before a single template is approved.
   * Outside that window Meta rejects it with error 131047, and that refusal is
   * surfaced rather than swallowed.
   */
  async sendText(params: SendTextMessageParams, config: ResolvedMessagingConfig): Promise<SendTemplateMessageResult> {
    const creds = config.whatsapp;
    if (!creds?.accessToken || !creds.phoneNumberId) {
      throw new Error("WhatsApp Cloud is selected but no phone number ID / access token is configured.");
    }

    const response = await fetch(`${this.apiBase}/${creds.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: params.to,
        type: "text",
        text: { preview_url: false, body: params.text },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      this.logger.error(`WhatsApp Cloud text send failed ${response.status}: ${body}`);
      throw new Error(`WhatsApp Cloud API error ${response.status}: ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as { messages?: Array<{ id: string }> };
    return { providerRef: json.messages?.[0]?.id ?? "unknown" };
  }

  /**
   * Blue ticks on the customer's side. Deliberately swallows its own failure:
   * this is called when staff open a thread, and a read receipt Meta refused is
   * never worth failing that request over.
   */
  async markRead(providerRef: string, config: ResolvedMessagingConfig): Promise<void> {
    const creds = config.whatsapp;
    if (!creds?.accessToken || !creds.phoneNumberId) return;
    try {
      const response = await fetch(`${this.apiBase}/${creds.phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: providerRef }),
      });
      if (!response.ok) {
        this.logger.warn(`Read receipt for ${providerRef} refused: ${response.status} ${(await response.text()).slice(0, 200)}`);
      }
    } catch (err) {
      this.logger.warn(`Read receipt for ${providerRef} failed: ${(err as Error).message}`);
    }
  }
}
