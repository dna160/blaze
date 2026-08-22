import { Module } from "@nestjs/common";

import { EMAIL_PROVIDER } from "./email-provider.interface.js";
import { MESSAGING_PROVIDER } from "./messaging-provider.interface.js";
import { NotificationsService } from "./notifications.service.js";
import { ConsoleLogEmailProvider } from "./providers/console-log-email.provider.js";
import { ConsoleLogMessagingProvider } from "./providers/console-log.provider.js";
import { ResendEmailProvider } from "./providers/resend-email.provider.js";
import { WhatsAppCloudMessagingProvider } from "./providers/whatsapp-cloud.provider.js";

/**
 * MESSAGING_PROVIDER / EMAIL_PROVIDER env vars select the adapters — both
 * default to console_log so local dev needs zero credentials (PRD v2 D3
 * added the email port alongside the existing WhatsApp one).
 */
@Module({
  providers: [
    ConsoleLogMessagingProvider,
    WhatsAppCloudMessagingProvider,
    ConsoleLogEmailProvider,
    ResendEmailProvider,
    {
      provide: MESSAGING_PROVIDER,
      useFactory: (consoleLog: ConsoleLogMessagingProvider, whatsapp: WhatsAppCloudMessagingProvider) =>
        process.env.MESSAGING_PROVIDER === "whatsapp_cloud" ? whatsapp : consoleLog,
      inject: [ConsoleLogMessagingProvider, WhatsAppCloudMessagingProvider],
    },
    {
      provide: EMAIL_PROVIDER,
      useFactory: (consoleLog: ConsoleLogEmailProvider, resend: ResendEmailProvider) =>
        process.env.EMAIL_PROVIDER === "resend" ? resend : consoleLog,
      inject: [ConsoleLogEmailProvider, ResendEmailProvider],
    },
    NotificationsService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
