/**
 * PRD go-live §4.3 — money cannot be marked received unless it was received.
 *
 * MockPaymentProvider confirms synchronously, so in a deployment where it is
 * active, a customer pressing Pay marks the invoice PAID with no money moved.
 * Two independent switches therefore have to be on before the portal offers
 * Pay or the API accepts a checkout:
 *
 *   1. the deployment has a real gateway: in production that means
 *      PAYMENT_PROVIDER=xendit. Missing or "mock" in production disables
 *      online payment (it does not crash the API — bank transfer still works);
 *   2. the branch opted in: Tenant.featureFlags.onlinePaymentsEnabled, default
 *      false, turned on once the client's own Xendit account exists.
 *
 * With either off, the portal shows the bank transfer details from Settings →
 * Branch and "send proof to WhatsApp CS", and POST /payments/initiate answers
 * 409. The only way to a SUCCEEDED payment is then a manual record verified by
 * a second person (maker-checker).
 */

export type OnlinePaymentsReason = "ENABLED" | "NO_GATEWAY_IN_PRODUCTION" | "BRANCH_DISABLED";

export function gatewayReady(env: NodeJS.ProcessEnv = process.env): boolean {
  const provider = env.PAYMENT_PROVIDER;
  if (env.NODE_ENV === "production") return provider === "xendit";
  return true;
}

export function onlinePaymentsStatus(
  featureFlags: Record<string, unknown> | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { enabled: boolean; reason: OnlinePaymentsReason } {
  if (!gatewayReady(env)) return { enabled: false, reason: "NO_GATEWAY_IN_PRODUCTION" };
  if (featureFlags?.onlinePaymentsEnabled !== true) return { enabled: false, reason: "BRANCH_DISABLED" };
  return { enabled: true, reason: "ENABLED" };
}
