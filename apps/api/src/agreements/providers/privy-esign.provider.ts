import { Injectable } from "@nestjs/common";

import type { ParsedEsignWebhookEvent, SendForSignatureParams, SendForSignatureResult, ESignProvider } from "../esign-provider.interface.js";

/**
 * Privy (privy.id) digital-signature + e-Meterai adapter — the PRD §11 /
 * docs/HANDOFF.md Phase 2 upgrade from wet-sign PDF for tenants that need
 * a legally-binding Indonesian e-signature. Coded against Privy's
 * documented REST API shape; requires PRIVY_API_KEY / PRIVY_MERCHANT_KEY
 * to actually run — like XenditPaymentProvider, this has not been
 * exercised against a live Privy sandbox, only structurally verified.
 * Validate against current Privy API docs before pointing this at
 * production. Selecting this over MockESignProvider is a single env var
 * (ESIGN_PROVIDER=privy, see agreements.module.ts) — no call-site change.
 */
@Injectable()
export class PrivyESignProvider implements ESignProvider {
  readonly name = "PRIVY";
  private readonly apiBase = "https://api.privy.id/v3";

  private apiKey(): string {
    const key = process.env.PRIVY_API_KEY;
    if (!key) {
      throw new Error("PRIVY_API_KEY is not configured — set ESIGN_PROVIDER=mock for local dev, or provide real credentials.");
    }
    return key;
  }

  private merchantKey(): string {
    const key = process.env.PRIVY_MERCHANT_KEY;
    if (!key) {
      throw new Error("PRIVY_MERCHANT_KEY is not configured — set ESIGN_PROVIDER=mock for local dev, or provide real credentials.");
    }
    return key;
  }

  async sendForSignature(params: SendForSignatureParams): Promise<SendForSignatureResult> {
    const form = new FormData();
    form.append("reference_number", params.envelopeRef);
    form.append(
      "document",
      new Blob([params.documentBuffer], { type: params.documentContentType }),
      `${params.envelopeRef}.pdf`,
    );
    form.append("recipient_name", params.signerName);
    form.append("recipient_phone", params.signerPhone);
    if (params.signerEmail) form.append("recipient_email", params.signerEmail);

    const response = await fetch(`${this.apiBase}/document/upload`, {
      method: "POST",
      headers: { Authorization: `Basic ${this.apiKey()}`, "X-Merchant-Key": this.merchantKey() },
      body: form,
    });

    if (!response.ok) {
      throw new Error(`Privy sendForSignature failed: ${response.status} ${await response.text()}`);
    }
    const json = (await response.json()) as { data: { doc_token: string } };
    return { envelopeId: json.data.doc_token, status: "PENDING" };
  }

  parseWebhook(rawBody: string, headers: Record<string, string>): ParsedEsignWebhookEvent {
    const signature = headers["x-privy-signature"];
    if (!signature) throw new Error("Missing Privy webhook signature header.");

    const payload = JSON.parse(rawBody) as { doc_token: string; status: string; signed_document_url?: string };
    const status: ParsedEsignWebhookEvent["status"] =
      payload.status === "completed" ? "SIGNED" : payload.status === "expired" ? "EXPIRED" : "DECLINED";

    return { envelopeId: payload.doc_token, status, signedDocumentUrl: payload.signed_document_url };
  }
}
