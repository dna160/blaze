import { Logger, Module } from "@nestjs/common";

import { BookingModule } from "../booking/booking.module.js";
import { FinanceModule } from "../finance/finance.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { StorageModule } from "../storage/storage.module.js";

import { gatewayReady } from "./online-payments.js";
import { PAYMENT_PROVIDER } from "./payment-provider.interface.js";
import { PaymentsController } from "./payments.controller.js";
import { PaymentsService } from "./payments.service.js";
import { MockPaymentProvider } from "./providers/mock-payment.provider.js";
import { XenditPaymentProvider } from "./providers/xendit-payment.provider.js";

/**
 * PAYMENT_PROVIDER env var selects the adapter — defaults to mock so local
 * dev/CI needs zero gateway credentials. In production, mock is still bound
 * (refunds and the DI graph need an adapter) but online checkout is refused
 * before it is ever called — see online-payments.ts (PRD go-live §4.3).
 */
@Module({
  imports: [BookingModule, FinanceModule, StorageModule, NotificationsModule],
  controllers: [PaymentsController],
  providers: [
    MockPaymentProvider,
    XenditPaymentProvider,
    {
      provide: PAYMENT_PROVIDER,
      useFactory: (mock: MockPaymentProvider, xendit: XenditPaymentProvider) => {
        if (process.env.PAYMENT_PROVIDER === "xendit") return xendit;
        if (!gatewayReady()) {
          new Logger("PaymentsModule").warn(
            "NODE_ENV=production without PAYMENT_PROVIDER=xendit — online payment is DISABLED for every branch. " +
              "Customers see bank transfer details; payments are recorded manually and verified by a second person.",
          );
        }
        return mock;
      },
      inject: [MockPaymentProvider, XenditPaymentProvider],
    },
    PaymentsService,
  ],
  exports: [PaymentsService, PAYMENT_PROVIDER],
})
export class PaymentsModule {}
