import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import type {
  KycVerificationParams,
  KycVerificationProvider,
  KycVerificationResult,
} from "../kyc-verification-provider.interface.js";

/**
 * Dev/demo default and zero-config: every document auto-verifies
 * synchronously, no external credentials needed — mirrors
 * MockESignProvider/MockPaymentProvider's "just works" behavior. This is
 * what actually runs for `sewa-alat`'s demo `kyc_auto_verification_enabled`
 * flag; a tenant that wants a real OCR/face-match check needs a real
 * provider configured (KYC_VERIFICATION_PROVIDER=verihubs).
 */
@Injectable()
export class MockKycVerificationProvider implements KycVerificationProvider {
  readonly name = "MOCK";

  async verify(_params: KycVerificationParams): Promise<KycVerificationResult> {
    return { status: "VERIFIED", providerRef: `mock-${randomUUID()}`, reason: "Mock provider auto-verified." };
  }
}
