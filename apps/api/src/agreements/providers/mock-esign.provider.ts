import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import type { ParsedEsignWebhookEvent, SendForSignatureParams, SendForSignatureResult, ESignProvider } from "../esign-provider.interface.js";

/**
 * Dev/test default and v1's actual behavior: treats the uploaded document
 * as already signed, synchronously — no envelope round-trip, no webhook.
 * This is deliberately what makes the wet-sign upload flow "just work"
 * with zero external credentials; AgreementsService.sign() branches on
 * `status` so swapping in a real provider later needs no call-site change.
 */
@Injectable()
export class MockESignProvider implements ESignProvider {
  readonly name = "MOCK";

  async sendForSignature(_params: SendForSignatureParams): Promise<SendForSignatureResult> {
    return { envelopeId: `mock-${randomUUID()}`, status: "SIGNED" };
  }

  parseWebhook(): ParsedEsignWebhookEvent {
    throw new Error("MockESignProvider signs synchronously and never sends webhooks.");
  }
}
