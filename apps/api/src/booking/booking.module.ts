import { Module } from "@nestjs/common";

import { CrmModule } from "../crm/crm.module.js";
import { FinanceModule } from "../finance/finance.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";

import { BookingController } from "./booking.controller.js";
import { BookingService } from "./booking.service.js";

@Module({
  imports: [CrmModule, FinanceModule, NotificationsModule],
  controllers: [BookingController],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule {}
