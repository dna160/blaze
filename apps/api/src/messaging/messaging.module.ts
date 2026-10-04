import { Module } from "@nestjs/common";

import { NotificationsModule } from "../notifications/notifications.module.js";
import { PrismaModule } from "../prisma/prisma.module.js";

import { MessagingController } from "./messaging.controller.js";
import { MessagingService } from "./messaging.service.js";

/** The console's WhatsApp inbox. Reads and writes the same `notifications` trail the webhook maintains. */
@Module({
  imports: [PrismaModule, NotificationsModule],
  controllers: [MessagingController],
  providers: [MessagingService],
})
export class MessagingModule {}
