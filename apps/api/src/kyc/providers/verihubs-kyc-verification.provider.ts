import { Injectable } from "@nestjs/common";

import type {
  KycVerificationParams,
  KycVerificationProvider,
  KycVerificationResult,
} from "../kyc-verification-provider.interface.js";

/**
 * Verihubs (verihubs.com) adapter — Indonesian KTP OCR + liveness/face
 * verification, the provider PRD §11/docs/HANDOFF.md name for automated
 * KYC. Coded against Verihubs' documented REST API shape; requires
 * VERIHUBS_API_KEY / VERIHUBS_APP_ID to actually run — like
 * XenditPaymentProvider/PrivyESignProvider, this has not been exercised
 * against a live Verihubs sandbox, only structurally verified. Validate
 * against current Verihubs API docs before pointing this at production.
 *
 * Simplification: KycService.upload() verifies each document
 * independently as it lands, not KTP+SELFIE as a matched pair — so this
 * calls Verihubs' single-document KTP-OCR-validity endpoint for a KTP
 * upload, and its liveness-detection endpoint for a SELFIE upload,
 * rather than Verihubs' face-match-against-KTP endpoint (which needs
 * both images at once). A real face-match pass is a genuine upgrade if
 * this becomes a priority — it would need `verify()` or its caller to
 * accept both documents together, not a small change to this file alone.
 */
@Injectable()
export class VerihubsKycVerificationProvider implements KycVerificationProvider {
  readonly name = "VERIHUBS";
  private readonly apiBase = "https://api.verihubs.com/v2";

  private apiKey(): string {
    const key = process.env.VERIHUBS_API_KEY;
    if (!key) {
      throw new Error("VERIHUBS_API_KEY is not configured — set KYC_VERIFICATION_PROVIDER=mock for local dev, or provide real credentials.");
    }
    return key;
  }

  private appId(): string {
    const id = process.env.VERIHUBS_APP_ID;
    if (!id) {
      throw new Error("VERIHUBS_APP_ID is not configured — set KYC_VERIFICATION_PROVIDER=mock for local dev, or provide real credentials.");
    }
    return id;
  }

  async verify(params: KycVerificationParams): Promise<KycVerificationResult> {
    return params.documentType === "KTP" ? this.verifyKtp(params) : this.verifyLiveness(params);
  }

  private async verifyKtp(params: KycVerificationParams): Promise<KycVerificationResult> {
    const form = new FormData();
    form.append("image", new Blob([params.buffer], { type: params.contentType }), "ktp.jpg");

    const response = await fetch(`${this.apiBase}/idcard/ocr`, {
      method: "POST",
      headers: { "App-Id": this.appId(), "App-Key": this.apiKey() },
      body: form,
    });
    if (!response.ok) throw new Error(`Verihubs KTP OCR failed: ${response.status} ${await response.text()}`);

    const json = (await response.json()) as {
      data: { nik?: string; is_valid?: boolean; confidence?: number };
      request_id: string;
    };
    if (json.data.is_valid && json.data.nik) {
      return { status: "VERIFIED", providerRef: json.request_id, reason: `NIK read with confidence ${json.data.confidence ?? "n/a"}.` };
    }
    if (json.data.confidence !== undefined && json.data.confidence < 0.5) {
      return { status: "REJECTED", providerRef: json.request_id, reason: "KTP image could not be read reliably — likely blurry or cropped." };
    }
    return { status: "PENDING", providerRef: json.request_id, reason: "Automated KTP check was inconclusive; needs manual review." };
  }

  private async verifyLiveness(params: KycVerificationParams): Promise<KycVerificationResult> {
    const form = new FormData();
    form.append("image", new Blob([params.buffer], { type: params.contentType }), "selfie.jpg");

    const response = await fetch(`${this.apiBase}/face/liveness`, {
      method: "POST",
      headers: { "App-Id": this.appId(), "App-Key": this.apiKey() },
      body: form,
    });
    if (!response.ok) throw new Error(`Verihubs liveness check failed: ${response.status} ${await response.text()}`);

    const json = (await response.json()) as { data: { is_live?: boolean; score?: number }; request_id: string };
    if (json.data.is_live) {
      return { status: "VERIFIED", providerRef: json.request_id, reason: `Liveness score ${json.data.score ?? "n/a"}.` };
    }
    if (json.data.score !== undefined && json.data.score < 0.3) {
      return { status: "REJECTED", providerRef: json.request_id, reason: "Selfie failed the liveness check (likely a photo of a photo, or no face detected)." };
    }
    return { status: "PENDING", providerRef: json.request_id, reason: "Automated liveness check was inconclusive; needs manual review." };
  }
}
