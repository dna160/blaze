import { Module } from "@nestjs/common";

import { NotificationsModule } from "../notifications/notifications.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { WaitlistModule } from "../waitlist/waitlist.module.js";

import { RentalOrderController } from "./rental-order.controller.js";
import { RentalOrderService } from "./rental-order.service.js";

@Module({
  imports: [PrismaModule, NotificationsModule, WaitlistModule],
  controllers: [RentalOrderController],
  providers: [RentalOrderService],
  exports: [RentalOrderService],
})
export class RentalOrderModule {}
