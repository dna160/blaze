import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import type {
  MessagingProvider,
  SendTemplateMessageParams,
  SendTemplateMessageResult,
} from "../messaging-provider.interface.js";

/** Dev/test default — logs instead of sending. Zero external credentials required to run the whole booking flow locally. */
@Injectable()
export class ConsoleLogMessagingProvider implements MessagingProvider {
  readonly name = "CONSOLE_LOG";
  private readonly logger = new Logger("MessagingProvider");

  async send(params: SendTemplateMessageParams): Promise<SendTemplateMessageResult> {
    this.logger.log(`[WA -> ${params.to}] ${params.templateKey} ${JSON.stringify(params.variables)}`);
    return { providerRef: `console-${randomUUID()}` };
  }
}
