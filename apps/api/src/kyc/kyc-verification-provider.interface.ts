export interface KycVerificationParams {
  documentType: "KTP" | "SELFIE";
  buffer: Buffer;
  contentType: string;
}

export interface KycVerificationResult {
  /** PENDING means the provider couldn't decide automatically — falls back to the existing manual review queue, same as if auto-verification were off. */
  status: "VERIFIED" | "REJECTED" | "PENDING";
  providerRef: string;
  /** Shown to staff verbatim — the provider's stated reason for a REJECTED or inconclusive PENDING result. */
  reason?: string;
}

/**
 * "Automated KYC verification (Verihubs or similar)" — PRD scopes this to
 * P2; Session 21 builds the port + a real-but-unconfigured adapter,
 * matching Payment/Messaging/Storage/ESign's existing pattern. Swapping
 * MockKycVerificationProvider for a real provider is a DI binding change
 * in kyc.module.ts (env var KYC_VERIFICATION_PROVIDER), not a call-site
 * change — KycService.upload() always calls verify() when the tenant's
 * featureFlags.kyc_auto_verification_enabled is on, and branches on the
 * returned status.
 */
export const KYC_VERIFICATION_PROVIDER = Symbol("KYC_VERIFICATION_PROVIDER");

export interface KycVerificationProvider {
  readonly name: string;
  verify(params: KycVerificationParams): Promise<KycVerificationResult>;
}
