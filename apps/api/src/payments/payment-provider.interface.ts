import type { Decimal } from "@rentos/domain";

export type PaymentMethodValue = "VIRTUAL_ACCOUNT" | "QRIS" | "EWALLET" | "CARD" | "MANUAL_TRANSFER" | "CASH";

export interface InitiatePaymentParams {
  invoiceId: string;
  amount: Decimal;
  method: PaymentMethodValue;
  idempotencyKey: string;
  customerPhone?: string;
}

export interface InitiatePaymentResult {
  providerRef: string;
  /** SUCCEEDED for synchronous confirmation (MockPaymentProvider); PENDING when a webhook will finalize it later (Xendit et al). */
  status: "PENDING" | "SUCCEEDED";
  /** Whatever the client needs to complete payment: VA number, QR string, redirect URL. Empty for mock. */
  instructions: Record<string, unknown>;
}

export interface ParsedWebhookEvent {
  externalId: string;
  eventType: string;
  providerRef: string;
  status: "SUCCEEDED" | "FAILED";
}

/**
 * "All gateway code isolated behind this interface — adding Stripe later
 * touches one module" (PRD §7.1.3). Swapping MockPaymentProvider for
 * XenditPaymentProvider is a DI binding change in payments.module.ts, not
 * a call-site change anywhere else.
 */
export const PAYMENT_PROVIDER = Symbol("PAYMENT_PROVIDER");

export interface PaymentProvider {
  readonly name: string;
  initiate(params: InitiatePaymentParams): Promise<InitiatePaymentResult>;
  parseWebhook(rawBody: string, headers: Record<string, string>): ParsedWebhookEvent;
  refund(providerRef: string, amount: Decimal): Promise<{ providerRef: string }>;
}
