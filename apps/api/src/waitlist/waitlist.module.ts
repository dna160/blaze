import { Module } from "@nestjs/common";

import { NotificationsModule } from "../notifications/notifications.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";

import { WaitlistController } from "./waitlist.controller.js";
import { WaitlistService } from "./waitlist.service.js";

@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [WaitlistController],
  providers: [WaitlistService],
  exports: [WaitlistService],
})
export class WaitlistModule {}
