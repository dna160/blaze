import { z } from "zod";

/**
 * PRD §5.3 / §11: wet-sign PDF upload is v1 scope (ESignProvider adapters
 * like Privy/e-Meterai are Phase 2). A Contract row is created
 * automatically when a booking is approved; signing it is a file upload,
 * not a JSON request — see apps/api/src/contracts/contracts.controller.ts.
 */
export const ContractDtoSchema = z.object({
  id: z.string().uuid(),
  bookingId: z.string().uuid(),
  templateVersion: z.string(),
  signedAt: z.string().datetime().nullable(),
  signedByName: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type ContractDto = z.infer<typeof ContractDtoSchema>;
