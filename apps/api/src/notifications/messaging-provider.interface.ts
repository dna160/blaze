export interface SendTemplateMessageParams {
  to: string;
  templateKey: string;
  variables: Record<string, string>;
}

export interface SendTemplateMessageResult {
  providerRef: string;
}

/**
 * "WhatsApp as primary channel, email as fallback/archive" (PRD §7.1.5) —
 * this is the ONLY interface booking/finance code depends on. Swapping
 * ConsoleLogMessagingProvider for WhatsAppCloudProvider in production is a
 * DI binding change (see notifications.module.ts), never a call-site
 * change.
 */
export const MESSAGING_PROVIDER = Symbol("MESSAGING_PROVIDER");

export interface MessagingProvider {
  readonly name: string;
  send(params: SendTemplateMessageParams): Promise<SendTemplateMessageResult>;
}
