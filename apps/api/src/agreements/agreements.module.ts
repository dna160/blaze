import { Module } from "@nestjs/common";

import { BookingModule } from "../booking/booking.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { StorageModule } from "../storage/storage.module.js";

import { AgreementsController } from "./agreements.controller.js";
import { AgreementsService } from "./agreements.service.js";
import { ESIGN_PROVIDER } from "./esign-provider.interface.js";
import { MasterAgreementController } from "./master-agreement.controller.js";
import { MasterAgreementService } from "./master-agreement.service.js";
import { OrderAcceptanceService } from "./order-acceptance.service.js";
import { MekariSignProvider } from "./providers/mekari-esign.provider.js";
import { MockESignProvider } from "./providers/mock-esign.provider.js";
import { PrivyESignProvider } from "./providers/privy-esign.provider.js";

/** ESIGN_PROVIDER env var selects the adapter — defaults to mock so local dev/CI
 *  needs zero e-sign credentials. "mekari" is the §5 primary certified provider. */
@Module({
  imports: [StorageModule, BookingModule, PrismaModule],
  controllers: [AgreementsController, MasterAgreementController],
  providers: [
    MockESignProvider,
    PrivyESignProvider,
    MekariSignProvider,
    {
      provide: ESIGN_PROVIDER,
      useFactory: (mock: MockESignProvider, privy: PrivyESignProvider, mekari: MekariSignProvider) => {
        switch (process.env.ESIGN_PROVIDER) {
          case "privy":
            return privy;
          case "mekari":
            return mekari;
          default:
            return mock;
        }
      },
      inject: [MockESignProvider, PrivyESignProvider, MekariSignProvider],
    },
    AgreementsService,
    MasterAgreementService,
    OrderAcceptanceService,
  ],
  exports: [AgreementsService, MasterAgreementService, OrderAcceptanceService],
})
export class AgreementsModule {}
