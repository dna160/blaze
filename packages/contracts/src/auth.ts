import { z } from "zod";

/** Console (staff) auth — email + password, JWT session (PRD §7.2.7 users & roles). */
export const ConsoleLoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
export type ConsoleLoginRequest = z.infer<typeof ConsoleLoginRequestSchema>;

export const SessionUserSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid().nullable(),
  email: z.string().email(),
  displayName: z.string().nullable(),
  roles: z.array(
    z.enum(["PLATFORM_ADMIN", "SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN", "VIEWER"]),
  ),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

export const ConsoleLoginResponseSchema = z.object({
  accessToken: z.string(),
  user: SessionUserSchema,
});
export type ConsoleLoginResponse = z.infer<typeof ConsoleLoginResponseSchema>;

/**
 * Customer auth — "phone number + WhatsApp OTP (primary)... No passwords
 * in v1 for customers; OTP-only" (PRD §7.1.2). v1 ships the request/verify
 * contract with a ConsoleLogProvider OTP adapter (see docs/HANDOFF.md) —
 * the WhatsApp OTP delivery itself is the same MessagingProvider seam
 * notifications use.
 */
export const OtpRequestSchema = z.object({
  phone: z.string().min(8).max(20),
});
export type OtpRequest = z.infer<typeof OtpRequestSchema>;

export const OtpVerifySchema = z.object({
  phone: z.string().min(8).max(20),
  code: z.string().length(6),
});
export type OtpVerify = z.infer<typeof OtpVerifySchema>;

export const CustomerSessionSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  phone: z.string(),
  fullName: z.string().nullable(),
});
export type CustomerSession = z.infer<typeof CustomerSessionSchema>;

export const CustomerAuthResponseSchema = z.object({
  accessToken: z.string(),
  customer: CustomerSessionSchema,
});
export type CustomerAuthResponse = z.infer<typeof CustomerAuthResponseSchema>;
