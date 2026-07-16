import { z } from "zod";

import { MoneyStringSchema } from "./common.js";

export const InvoiceStatusSchema = z.enum([
  "SCHEDULED",
  "ISSUED",
  "OVERDUE",
  "PAID",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "VOID",
  "CREDITED",
]);

export const InvoiceLineDtoSchema = z.object({
  description: z.string(),
  quantity: z.string(),
  unitPrice: MoneyStringSchema,
  amount: MoneyStringSchema,
  lineType: z.enum(["RENT", "DEPOSIT", "ADMIN_FEE", "TAX", "DISCOUNT", "DAMAGE"]),
});
export type InvoiceLineDto = z.infer<typeof InvoiceLineDtoSchema>;

export const InvoiceDtoSchema = z.object({
  id: z.string().uuid(),
  invoiceNumber: z.string(),
  status: InvoiceStatusSchema,
  currency: z.string().length(3),
  subtotal: MoneyStringSchema,
  taxAmount: MoneyStringSchema,
  totalAmount: MoneyStringSchema,
  issueDate: z.string().datetime(),
  dueDate: z.string().datetime(),
  paidAt: z.string().datetime().nullable(),
  lines: z.array(InvoiceLineDtoSchema),
});
export type InvoiceDto = z.infer<typeof InvoiceDtoSchema>;

export const PaymentStatusSchema = z.enum(["PENDING", "SUCCEEDED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED"]);

export const PaymentMethodSchema = z.enum(["VIRTUAL_ACCOUNT", "QRIS", "EWALLET", "CARD", "MANUAL_TRANSFER", "CASH"]);

export const PaymentDtoSchema = z.object({
  id: z.string().uuid(),
  invoiceId: z.string().uuid(),
  provider: z.string(),
  method: PaymentMethodSchema,
  status: PaymentStatusSchema,
  amount: MoneyStringSchema,
  paidAt: z.string().datetime().nullable(),
});
export type PaymentDto = z.infer<typeof PaymentDtoSchema>;

/**
 * Storefront checkout hits POST /payments/initiate, which returns a
 * provider-specific redirect/QR payload. The PaymentProvider abstraction
 * lives in apps/api — this schema is deliberately provider-agnostic; the
 * `instructions` bag carries whatever the active adapter needs the client
 * to render (VA number, QR string, redirect URL, or — for MockPaymentProvider
 * in dev — nothing, since it auto-confirms).
 */
export const InitiatePaymentRequestSchema = z.object({
  invoiceId: z.string().uuid(),
  method: PaymentMethodSchema,
});
export type InitiatePaymentRequest = z.infer<typeof InitiatePaymentRequestSchema>;

export const InitiatePaymentResponseSchema = z.object({
  paymentId: z.string().uuid(),
  status: PaymentStatusSchema,
  instructions: z.record(z.unknown()),
});
export type InitiatePaymentResponse = z.infer<typeof InitiatePaymentResponseSchema>;
