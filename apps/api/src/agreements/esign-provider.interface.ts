export interface SendForSignatureParams {
  /** Our Contract id — used as the provider's external reference so a webhook can be matched back without a lookup table. */
  envelopeRef: string;
  documentBuffer: Buffer;
  documentContentType: string;
  signerName: string;
  /** Nullable since PRD v2 D3 — a Google-signed-in customer may only have an email. */
  signerPhone: string | null;
  signerEmail?: string;
}

export interface SendForSignatureResult {
  envelopeId: string;
  /** SUCCEEDED for synchronous completion (MockESignProvider); PENDING when a webhook will finalize it later (a real provider). */
  status: "PENDING" | "SIGNED";
}

export interface ParsedEsignWebhookEvent {
  envelopeId: string;
  status: "SIGNED" | "DECLINED" | "EXPIRED";
  /** Present when the provider returns a re-fetchable signed-document URL distinct from what was uploaded. */
  signedDocumentUrl?: string;
}

/**
 * "ESignProvider as its own port/adapter (matching Payment/Messaging/
 * Storage)" — PRD §11 scopes wet-sign PDF upload as v1-acceptable; this is
 * the Phase 2 upgrade path for tenants that need a legally-binding
 * e-Meterai/digital signature instead. Swapping MockESignProvider for a
 * real provider is a DI binding change in agreements.module.ts (env var
 * ESIGN_PROVIDER), not a call-site change — AgreementsService.sign()
 * always calls sendForSignature() and branches on the returned status.
 */
export const ESIGN_PROVIDER = Symbol("ESIGN_PROVIDER");

export interface ESignProvider {
  readonly name: string;
  sendForSignature(params: SendForSignatureParams): Promise<SendForSignatureResult>;
  parseWebhook(rawBody: string, headers: Record<string, string>): ParsedEsignWebhookEvent;
}
