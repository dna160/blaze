import { Injectable, Logger } from "@nestjs/common";

import type { EmailProvider, SendEmailParams, SendEmailResult } from "../email-provider.interface.js";

/**
 * Resend (resend.com) adapter — coded against the documented REST shape,
 * requires RESEND_API_KEY and EMAIL_FROM to actually send. Like the
 * Xendit/WhatsApp/Privy/Verihubs adapters this is structurally verified,
 * not exercised against a live account in the sandbox that built it.
 */
@Injectable()
export class ResendEmailProvider implements EmailProvider {
  readonly name = "RESEND";
  private readonly logger = new Logger("EmailProvider");

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    if (!apiKey || !from) {
      throw new Error("RESEND_API_KEY / EMAIL_FROM are not configured — set EMAIL_PROVIDER=console_log for local dev, or provide real credentials.");
    }
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [params.to], subject: params.subject, text: params.text, html: params.html }),
    });
    if (!response.ok) {
      const body = await response.text();
      this.logger.error(`Resend API error ${response.status}: ${body}`);
      throw new Error(`Resend API error ${response.status}`);
    }
    const json = (await response.json()) as { id?: string };
    return { providerRef: json.id ?? "unknown" };
  }
}
