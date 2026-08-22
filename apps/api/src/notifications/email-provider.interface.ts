export interface SendEmailParams {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface SendEmailResult {
  providerRef: string;
}

/**
 * PRD v2 D3: customers who signed in with Google are keyed by email and get
 * EMAIL instead of WhatsApp for every message. Same port pattern as
 * MessagingProvider — ConsoleLogEmailProvider is the zero-config default,
 * ResendEmailProvider is coded against Resend's REST API and selected by
 * EMAIL_PROVIDER=resend (+ RESEND_API_KEY, EMAIL_FROM). No call site ever
 * branches on which adapter is bound.
 */
export const EMAIL_PROVIDER = Symbol("EMAIL_PROVIDER");

export interface EmailProvider {
  readonly name: string;
  send(params: SendEmailParams): Promise<SendEmailResult>;
}
