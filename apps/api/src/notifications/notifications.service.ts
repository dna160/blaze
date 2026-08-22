import { Inject, Injectable, Logger } from "@nestjs/common";

import { PrismaService } from "../prisma/prisma.service.js";

import { MESSAGING_PROVIDER, type MessagingProvider } from "./messaging-provider.interface.js";

export interface NotifyParams {
  tenantId: string;
  customerId?: string;
  channel: "WHATSAPP" | "EMAIL";
  templateKey: string;
  recipient: string;
  variables: Record<string, string>;
}

/**
 * Every outbound customer message is persisted to `notifications` first
 * (QUEUED), then sent — so a provider outage leaves an auditable trail of
 * what SHOULD have gone out, not silence (PRD §10 Reliability: dead-letter
 * queues for money-adjacent jobs; the same discipline applies to comms).
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MESSAGING_PROVIDER) private readonly provider: MessagingProvider,
  ) {}

  async notify(params: NotifyParams): Promise<void> {
    const record = await this.prisma.runInTenantContext(params.tenantId, (tx) =>
      tx.notification.create({
        data: {
          tenantId: params.tenantId,
          customerId: params.customerId,
          channel: params.channel,
          templateKey: params.templateKey,
          recipient: params.recipient,
          payload: params.variables,
          status: "QUEUED",
        },
      }),
    );

    try {
      const result = await this.provider.send({
        to: params.recipient,
        templateKey: params.templateKey,
        variables: params.variables,
      });
      await this.prisma.runInTenantContext(params.tenantId, (tx) =>
        tx.notification.update({
          where: { id: record.id },
          data: { status: "SENT", providerRef: result.providerRef, sentAt: new Date() },
        }),
      );
    } catch (err) {
      this.logger.error(`Notification ${record.id} failed to send: ${(err as Error).message}`);
      await this.prisma.runInTenantContext(params.tenantId, (tx) =>
        tx.notification.update({
          where: { id: record.id },
          data: { status: "FAILED", error: (err as Error).message },
        }),
      );
    }
  }
}
