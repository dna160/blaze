import { Module } from "@nestjs/common";

import { BookingModule } from "../booking/booking.module.js";
import { StorageModule } from "../storage/storage.module.js";

import { AgreementsController } from "./agreements.controller.js";
import { AgreementsService } from "./agreements.service.js";
import { ESIGN_PROVIDER } from "./esign-provider.interface.js";
import { MockESignProvider } from "./providers/mock-esign.provider.js";
import { PrivyESignProvider } from "./providers/privy-esign.provider.js";

/** ESIGN_PROVIDER env var selects the adapter — defaults to mock so local dev/CI needs zero e-sign credentials. */
@Module({
  imports: [StorageModule, BookingModule],
  controllers: [AgreementsController],
  providers: [
    MockESignProvider,
    PrivyESignProvider,
    {
      provide: ESIGN_PROVIDER,
      useFactory: (mock: MockESignProvider, privy: PrivyESignProvider) =>
        process.env.ESIGN_PROVIDER === "privy" ? privy : mock,
      inject: [MockESignProvider, PrivyESignProvider],
    },
    AgreementsService,
  ],
  exports: [AgreementsService],
})
export class AgreementsModule {}
