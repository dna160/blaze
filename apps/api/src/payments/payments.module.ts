import { Module } from "@nestjs/common";

import { BookingModule } from "../booking/booking.module.js";
import { FinanceModule } from "../finance/finance.module.js";

import { PAYMENT_PROVIDER } from "./payment-provider.interface.js";
import { PaymentsController } from "./payments.controller.js";
import { PaymentsService } from "./payments.service.js";
import { MockPaymentProvider } from "./providers/mock-payment.provider.js";
import { XenditPaymentProvider } from "./providers/xendit-payment.provider.js";

/** PAYMENT_PROVIDER env var selects the adapter — defaults to mock so local dev/CI needs zero gateway credentials. */
@Module({
  imports: [BookingModule, FinanceModule],
  controllers: [PaymentsController],
  providers: [
    MockPaymentProvider,
    XenditPaymentProvider,
    {
      provide: PAYMENT_PROVIDER,
      useFactory: (mock: MockPaymentProvider, xendit: XenditPaymentProvider) =>
        process.env.PAYMENT_PROVIDER === "xendit" ? xendit : mock,
      inject: [MockPaymentProvider, XenditPaymentProvider],
    },
    PaymentsService,
  ],
  exports: [PaymentsService, PAYMENT_PROVIDER],
})
export class PaymentsModule {}
