import { Module } from "@nestjs/common";

import { MESSAGING_PROVIDER } from "./messaging-provider.interface.js";
import { NotificationsService } from "./notifications.service.js";
import { ConsoleLogMessagingProvider } from "./providers/console-log.provider.js";
import { WhatsAppCloudMessagingProvider } from "./providers/whatsapp-cloud.provider.js";

/** MESSAGING_PROVIDER env var selects the adapter — defaults to console_log so local dev needs zero credentials. */
@Module({
  providers: [
    ConsoleLogMessagingProvider,
    WhatsAppCloudMessagingProvider,
    {
      provide: MESSAGING_PROVIDER,
      useFactory: (consoleLog: ConsoleLogMessagingProvider, whatsapp: WhatsAppCloudMessagingProvider) =>
        process.env.MESSAGING_PROVIDER === "whatsapp_cloud" ? whatsapp : consoleLog,
      inject: [ConsoleLogMessagingProvider, WhatsAppCloudMessagingProvider],
    },
    NotificationsService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
