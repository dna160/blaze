import { Injectable, Logger } from "@nestjs/common";

import type {
  MessagingProvider,
  SendTemplateMessageParams,
  SendTemplateMessageResult,
} from "../messaging-provider.interface.js";

/**
 * Meta WhatsApp Cloud API adapter — coded against the real API shape but
 * requires WHATSAPP_CLOUD_TOKEN / WHATSAPP_PHONE_NUMBER_ID to actually
 * send (PRD §7.1.5, §11 MessagingProvider port). Selecting this over
 * ConsoleLogMessagingProvider is a single env var
 * (MESSAGING_PROVIDER=whatsapp_cloud, see notifications.module.ts) — no
 * code change in any caller.
 */
@Injectable()
export class WhatsAppCloudMessagingProvider implements MessagingProvider {
  readonly name = "WHATSAPP_CLOUD";
  private readonly logger = new Logger("MessagingProvider");
  private readonly apiBase = "https://graph.facebook.com/v21.0";

  async send(params: SendTemplateMessageParams): Promise<SendTemplateMessageResult> {
    const token = process.env.WHATSAPP_CLOUD_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    if (!token || !phoneNumberId) {
      throw new Error(
        "WHATSAPP_CLOUD_TOKEN / WHATSAPP_PHONE_NUMBER_ID are not configured — " +
          "set MESSAGING_PROVIDER=console_log for local dev, or provide real credentials.",
      );
    }

    const response = await fetch(`${this.apiBase}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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
      this.logger.error(`WhatsApp Cloud API error ${response.status}: ${body}`);
      throw new Error(`WhatsApp Cloud API error ${response.status}`);
    }

    const json = (await response.json()) as { messages?: Array<{ id: string }> };
    return { providerRef: json.messages?.[0]?.id ?? "unknown" };
  }
}
