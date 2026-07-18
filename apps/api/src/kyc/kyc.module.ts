import { Module } from "@nestjs/common";

import { StorageModule } from "../storage/storage.module.js";

import { KycController } from "./kyc.controller.js";
import { KYC_VERIFICATION_PROVIDER } from "./kyc-verification-provider.interface.js";
import { KycService } from "./kyc.service.js";
import { MockKycVerificationProvider } from "./providers/mock-kyc-verification.provider.js";
import { VerihubsKycVerificationProvider } from "./providers/verihubs-kyc-verification.provider.js";

/** KYC_VERIFICATION_PROVIDER env var selects the adapter — defaults to mock so local dev/CI needs zero KYC-verification credentials. */
@Module({
  imports: [StorageModule],
  controllers: [KycController],
  providers: [
    MockKycVerificationProvider,
    VerihubsKycVerificationProvider,
    {
      provide: KYC_VERIFICATION_PROVIDER,
      useFactory: (mock: MockKycVerificationProvider, verihubs: VerihubsKycVerificationProvider) =>
        process.env.KYC_VERIFICATION_PROVIDER === "verihubs" ? verihubs : mock,
      inject: [MockKycVerificationProvider, VerihubsKycVerificationProvider],
    },
    KycService,
  ],
  exports: [KycService],
})
export class KycModule {}
