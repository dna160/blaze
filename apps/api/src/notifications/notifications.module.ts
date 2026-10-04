import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module.js";

import { EMAIL_PROVIDER } from "./email-provider.interface.js";
import { MESSAGING_PROVIDERS, type MessagingProviderRegistry } from "./messaging-provider.interface.js";
import { NotificationsController } from "./notifications.controller.js";
import { NotificationsService } from "./notifications.service.js";
import { ConsoleLogEmailProvider } from "./providers/console-log-email.provider.js";
import { ConsoleLogMessagingProvider } from "./providers/console-log.provider.js";
import { ResendEmailProvider } from "./providers/resend-email.provider.js";
import { WhatsAppCloudMessagingProvider } from "./providers/whatsapp-cloud.provider.js";
import { WhatsAppWebhookService } from "./whatsapp-webhook.service.js";

/**
 * The WhatsApp adapter is no longer chosen at boot: #40 puts the number on the
 * organization, set from the console, so NotificationsService picks per send
 * from this registry using the resolved config. EMAIL_PROVIDER stays an env
 * choice — Resend is one account for the whole deployment, not per org.
 * Both default to console_log so local dev needs zero credentials.
 */
@Module({
  imports: [PrismaModule],
  controllers: [NotificationsController],
  providers: [
    WhatsAppWebhookService,
    ConsoleLogMessagingProvider,
    WhatsAppCloudMessagingProvider,
    ConsoleLogEmailProvider,
    ResendEmailProvider,
    {
      provide: MESSAGING_PROVIDERS,
      useFactory: (consoleLog: ConsoleLogMessagingProvider, whatsapp: WhatsAppCloudMessagingProvider): MessagingProviderRegistry => ({
        console_log: consoleLog,
        whatsapp_cloud: whatsapp,
      }),
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
  exports: [NotificationsService, MESSAGING_PROVIDERS],
})
export class NotificationsModule {}
