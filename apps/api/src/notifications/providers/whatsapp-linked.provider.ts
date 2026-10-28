import { Injectable, Logger } from "@nestjs/common";
import { WaBridgeError, waBridgeMarkRead, waBridgeSendText, type ResolvedMessagingConfig } from "@rentos/database";
import { renderMessage } from "@rentos/domain";

import type {
  MessagingProvider,
  SendTemplateMessageParams,
  SendTextMessageParams,
  SendTemplateMessageResult,
} from "../messaging-provider.interface.js";
import { WhatsAppSendError } from "./whatsapp-send-error.js";

/**
 * WhatsApp through the organization's own linked device (apps/wa-bridge —
 * Project Smile's whatsmeow route), instead of Meta's Cloud API.
 *
 * There is no template registry on this path: a "template" send renders the
 * same bilingual copy the email channel uses (packages/domain comms/templates)
 * and sends it as plain text, so every lifecycle message works the moment the
 * number is paired, with nothing waiting on Meta's review.
 */
@Injectable()
export class WhatsAppLinkedMessagingProvider implements MessagingProvider {
  readonly name = "WHATSAPP_LINKED";
  readonly enforcesReplyWindow = false;
  private readonly logger = new Logger("MessagingProvider");

  async send(params: SendTemplateMessageParams, config: ResolvedMessagingConfig): Promise<SendTemplateMessageResult> {
    const { text } = renderMessage(params.templateKey, params.variables);
    return this.sendText({ to: params.to, text }, config);
  }

  async sendText(params: SendTextMessageParams, config: ResolvedMessagingConfig): Promise<SendTemplateMessageResult> {
    const conn = this.connection(config);
    try {
      const { id } = await waBridgeSendText(conn, params.to, params.text);
      return { providerRef: id };
    } catch (err) {
      throw toSendError(err);
    }
  }

  /** Blue ticks. Swallows its own failure for the same reason the Cloud adapter does. */
  async markRead(providerRef: string, config: ResolvedMessagingConfig): Promise<void> {
    if (!config.linked) return;
    try {
      await waBridgeMarkRead(config.linked, [providerRef]);
    } catch (err) {
      this.logger.warn(`Read receipt for ${providerRef} failed: ${(err as Error).message}`);
    }
  }

  private connection(config: ResolvedMessagingConfig) {
    if (!config.linked) {
      throw new WhatsAppSendError(
        "WhatsApp (linked device) is selected but WA_BRIDGE_URL / WA_BRIDGE_TOKEN are not set on this service.",
        503,
        null,
        null,
        null,
        true,
      );
    }
    return config.linked;
  }
}

/** Keeps the bridge's own channel-wide verdict, so the sign-in breaker in NotificationsService still works. */
function toSendError(err: unknown): WhatsAppSendError {
  if (err instanceof WaBridgeError) {
    return new WhatsAppSendError(`WhatsApp (linked device): ${err.message}`, err.status, null, null, err.code, err.channelWide);
  }
  return new WhatsAppSendError(`WhatsApp (linked device): ${(err as Error).message}`, 0, null, null, null, false);
}
