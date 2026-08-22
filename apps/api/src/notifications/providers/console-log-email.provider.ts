import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import type { EmailProvider, SendEmailParams, SendEmailResult } from "../email-provider.interface.js";

/** Dev/test default — logs instead of sending, mirroring ConsoleLogMessagingProvider. */
@Injectable()
export class ConsoleLogEmailProvider implements EmailProvider {
  readonly name = "CONSOLE_LOG";
  private readonly logger = new Logger("EmailProvider");

  async send(params: SendEmailParams): Promise<SendEmailResult> {
    this.logger.log(`[EMAIL -> ${params.to}] ${params.subject}\n${params.text}`);
    return { providerRef: `console-${randomUUID()}` };
  }
}
