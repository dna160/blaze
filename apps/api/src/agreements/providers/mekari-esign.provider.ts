import { Injectable, Logger } from "@nestjs/common";

import type {
  ESignProvider,
  ParsedEsignWebhookEvent,
  SendForSignatureParams,
  SendForSignatureResult,
} from "../esign-provider.interface.js";

/**
 * BUILD-SPEC §5 — Mekari Sign adapter (primary certified-signature provider:
 * API-first, e-Meterai available, signers need no account, sandbox available).
 * Used ONLY for the once-per-customer MASTER agreement — monthly orders are
 * accepted via OTP (OrderAcceptanceService), consuming no certified signature.
 *
 * Unconfigured by default: ESIGN_PROVIDER stays "mock" until MEKARI_* env vars
 * land (B3 approved order-level OTP, so the certified path is master-only). When
 * selected, sendForSignature creates an async envelope (status PENDING) that a
 * webhook finalizes via parseWebhook — matching the port's async contract.
 */
@Injectable()
export class MekariSignProvider implements ESignProvider {
  readonly name = "MEKARI";
  private readonly logger = new Logger(MekariSignProvider.name);

  private config() {
    const baseUrl = process.env.MEKARI_SIGN_BASE_URL ?? "https://sign.mekari.com/api/v1";
    const apiKey = process.env.MEKARI_SIGN_API_KEY;
    const apiSecret = process.env.MEKARI_SIGN_API_SECRET;
    if (!apiKey || !apiSecret) {
      throw new Error("MEKARI_SIGN_API_KEY / MEKARI_SIGN_API_SECRET are not configured.");
    }
    return { baseUrl, apiKey, apiSecret };
  }

  async sendForSignature(params: SendForSignatureParams): Promise<SendForSignatureResult> {
    const { baseUrl, apiKey, apiSecret } = this.config();
    const response = await fetch(`${baseUrl}/documents`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Api-Secret": apiSecret,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // envelopeRef is our Contract id — echoed back on the webhook so we match
        // without a lookup table (mirrors the port's documented convention).
        external_id: params.envelopeRef,
        document_base64: params.documentBuffer.toString("base64"),
        content_type: params.documentContentType,
        signers: [
          {
            name: params.signerName,
            phone: params.signerPhone,
            email: params.signerEmail,
            // e-Meterai is intentionally NOT requested (B9: signature only).
            emeterai: false,
          },
        ],
      }),
    });
    if (!response.ok) {
      throw new Error(`Mekari Sign API error ${response.status}: ${await response.text()}`);
    }
    const json = (await response.json()) as { data?: { id?: string; status?: string } };
    const envelopeId = json.data?.id;
    if (!envelopeId) throw new Error("Mekari Sign returned no document id.");
    this.logger.log(`Mekari envelope ${envelopeId} created for ref ${params.envelopeRef}`);
    // Certified signing is asynchronous — a webhook finalizes it.
    return { envelopeId, status: "PENDING" };
  }

  parseWebhook(rawBody: string): ParsedEsignWebhookEvent {
    const payload = JSON.parse(rawBody) as {
      data?: { id?: string; status?: string; signed_document_url?: string };
    };
    const envelopeId = payload.data?.id;
    if (!envelopeId) throw new Error("Mekari webhook missing document id.");
    const raw = (payload.data?.status ?? "").toLowerCase();
    const status: ParsedEsignWebhookEvent["status"] =
      raw === "completed" || raw === "signed" ? "SIGNED" : raw === "declined" || raw === "rejected" ? "DECLINED" : "EXPIRED";
    return { envelopeId, status, signedDocumentUrl: payload.data?.signed_document_url };
  }
}
