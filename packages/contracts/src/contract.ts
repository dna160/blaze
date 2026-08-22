import { z } from "zod";

/**
 * PRD §5.3 / §11: wet-sign PDF upload is v1-acceptable; every upload
 * routes through an ESignProvider (apps/api/src/agreements) that defaults
 * to a synchronous mock — real providers (Privy/e-Meterai) are a Phase 2
 * config change. `esignStatus` distinguishes "signed" from "sent to a
 * real provider, awaiting completion" — signing is always a file upload,
 * not a JSON request, see apps/api/src/agreements/agreements.controller.ts.
 */
export const ContractDtoSchema = z.object({
  id: z.string().uuid(),
  bookingId: z.string().uuid(),
  templateVersion: z.string(),
  signedAt: z.string().datetime().nullable(),
  signedByName: z.string().nullable(),
  esignProvider: z.string().nullable(),
  esignStatus: z.enum(["PENDING", "SIGNED", "DECLINED", "EXPIRED"]).nullable(),
  createdAt: z.string().datetime(),
});
export type ContractDto = z.infer<typeof ContractDtoSchema>;
