import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import type {
  InitiatePaymentParams,
  InitiatePaymentResult,
  ParsedWebhookEvent,
  PaymentProvider,
} from "../payment-provider.interface.js";

import type { Decimal } from "@rentos/domain";

/**
 * Dev/test default: confirms every payment instantly and synchronously —
 * no webhook round-trip needed, so the whole booking->pay->ACTIVE flow
 * runs end to end with zero external credentials. PaymentsService treats
 * a SUCCEEDED result from initiate() as equivalent to an instant webhook
 * (see payments.service.ts), which is the one deliberate simplification
 * this provider makes versus a real gateway.
 */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "MOCK";

  async initiate(params: InitiatePaymentParams): Promise<InitiatePaymentResult> {
    return {
      providerRef: `mock-${randomUUID()}`,
      status: "SUCCEEDED",
      instructions: { note: "Mock payment auto-confirmed — no real money moved.", amount: params.amount.toString() },
    };
  }

  parseWebhook(): ParsedWebhookEvent {
    throw new Error("MockPaymentProvider confirms synchronously and never sends webhooks.");
  }

  async refund(providerRef: string, amount: Decimal): Promise<{ providerRef: string }> {
    return { providerRef: `mock-refund-${providerRef}-${amount.toString()}` };
  }
}
