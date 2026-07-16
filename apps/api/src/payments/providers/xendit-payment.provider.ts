import { Injectable } from "@nestjs/common";

import type {
  InitiatePaymentParams,
  InitiatePaymentResult,
  ParsedWebhookEvent,
  PaymentProvider,
} from "../payment-provider.interface.js";

import type { Decimal } from "@rentos/domain";

/**
 * Xendit adapter (PRD §7.1.3: "Gateway: Xendit primary — broadest VA + QRIS
 * + e-wallet coverage"). Coded against Xendit's real API shape; requires
 * XENDIT_SECRET_KEY / XENDIT_WEBHOOK_TOKEN to actually run. Selecting this
 * over MockPaymentProvider is a single env var
 * (PAYMENT_PROVIDER=xendit, see payments.module.ts) — no call-site change.
 */
@Injectable()
export class XenditPaymentProvider implements PaymentProvider {
  readonly name = "XENDIT";
  private readonly apiBase = "https://api.xendit.co";

  private secretKey(): string {
    const key = process.env.XENDIT_SECRET_KEY;
    if (!key) {
      throw new Error(
        "XENDIT_SECRET_KEY is not configured — set PAYMENT_PROVIDER=mock for local dev, or provide real credentials.",
      );
    }
    return key;
  }

  async initiate(params: InitiatePaymentParams): Promise<InitiatePaymentResult> {
    const auth = Buffer.from(`${this.secretKey()}:`).toString("base64");
    const response = await fetch(`${this.apiBase}/v2/invoices`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
        "X-IDEMPOTENCY-KEY": params.idempotencyKey,
      },
      body: JSON.stringify({
        external_id: params.invoiceId,
        amount: Number(params.amount.toString()),
        currency: "IDR",
        payment_methods: [xenditMethodFor(params.method)],
      }),
    });

    if (!response.ok) {
      throw new Error(`Xendit initiate failed: ${response.status} ${await response.text()}`);
    }
    const json = (await response.json()) as { id: string; invoice_url: string };
    return { providerRef: json.id, status: "PENDING", instructions: { redirectUrl: json.invoice_url } };
  }

  parseWebhook(rawBody: string, headers: Record<string, string>): ParsedWebhookEvent {
    const webhookToken = process.env.XENDIT_WEBHOOK_TOKEN;
    if (!webhookToken) throw new Error("XENDIT_WEBHOOK_TOKEN is not configured.");

    const signature = headers["x-callback-token"];
    if (signature !== webhookToken) {
      throw new Error("Invalid Xendit webhook signature.");
    }

    const payload = JSON.parse(rawBody) as { id: string; external_id: string; status: string };
    return {
      externalId: payload.id,
      eventType: "invoice.status_changed",
      providerRef: payload.id,
      status: payload.status === "PAID" || payload.status === "SETTLED" ? "SUCCEEDED" : "FAILED",
    };
  }

  async refund(providerRef: string, amount: Decimal): Promise<{ providerRef: string }> {
    const auth = Buffer.from(`${this.secretKey()}:`).toString("base64");
    const response = await fetch(`${this.apiBase}/refunds`, {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({ invoice_id: providerRef, amount: Number(amount.toString()) }),
    });
    if (!response.ok) {
      throw new Error(`Xendit refund failed: ${response.status} ${await response.text()}`);
    }
    const json = (await response.json()) as { id: string };
    return { providerRef: json.id };
  }
}

function xenditMethodFor(method: InitiatePaymentParams["method"]): string {
  switch (method) {
    case "VIRTUAL_ACCOUNT":
      return "BANK_TRANSFER";
    case "QRIS":
      return "QR_CODE";
    case "EWALLET":
      return "EWALLET";
    case "CARD":
      return "CREDIT_CARD";
    default:
      throw new Error(`Xendit does not support method ${method} through this adapter.`);
  }
}
