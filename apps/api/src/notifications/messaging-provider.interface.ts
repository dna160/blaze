import type { MessagingProviderName, ResolvedMessagingConfig } from "@rentos/database";

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
 * this is the ONLY interface booking/finance code depends on.
 *
 * Which adapter runs is now decided PER SEND, not once at boot: #40 puts the
 * WhatsApp number on the organization, configured from the console, so two
 * orgs served by the same deployment send from different numbers. The
 * credentials therefore arrive as an argument rather than being read from the
 * environment inside the adapter — that is what makes the adapter tenant-safe
 * and what lets the console send a test message with credentials that have not
 * been saved yet.
 */
export const MESSAGING_PROVIDERS = Symbol("MESSAGING_PROVIDERS");

export interface SendTextMessageParams {
  to: string;
  text: string;
}

export interface MessagingProvider {
  readonly name: string;
  send(params: SendTemplateMessageParams, config: ResolvedMessagingConfig): Promise<SendTemplateMessageResult>;
  /**
   * Free-form text, which WhatsApp permits only inside the 24-hour customer
   * service window — i.e. within 24h of the customer's own last message. Every
   * caller today is replying TO an inbound message, so the window is open by
   * construction; anything business-initiated must still go through `send` and
   * an approved template.
   */
  sendText(params: SendTextMessageParams, config: ResolvedMessagingConfig): Promise<SendTemplateMessageResult>;
}

/** Every adapter, keyed by the provider name stored on the organization. */
export type MessagingProviderRegistry = Record<MessagingProviderName, MessagingProvider>;
