import { Injectable, Logger } from "@nestjs/common";
import type { ResolvedMessagingConfig } from "@rentos/database";

import type {
  MessagingProvider,
  SendTemplateMessageParams,
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
  private readonly apiBase = "https://graph.facebook.com/v21.0";

  async send(params: SendTemplateMessageParams, config: ResolvedMessagingConfig): Promise<SendTemplateMessageResult> {
    const creds = config.whatsapp;
    if (!creds?.accessToken || !creds.phoneNumberId) {
      throw new Error(
        "WhatsApp Cloud is selected but no phone number ID / access token is configured — " +
          "set them in Console → Settings → Messaging, or switch the provider back to console_log.",
      );
    }

    const response = await fetch(`${this.apiBase}/${creds.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: params.to,
        type: "template",
        template: {
          name: params.templateKey,
          language: { code: "id" },
          components: [
            {
              type: "body",
              parameters: Object.values(params.variables).map((text) => ({ type: "text", text })),
            },
          ],
        },
      }),
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
}
