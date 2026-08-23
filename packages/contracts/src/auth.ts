import { z } from "zod";

/** Console (staff) auth — email + password, JWT session (PRD §7.2.7 users & roles). */
export const ConsoleLoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});
export type ConsoleLoginRequest = z.infer<typeof ConsoleLoginRequestSchema>;

/** BUILD-SPEC C2 — role × scope. Mirrors Prisma BaseRole/RoleScope + UserRole. */
export const BaseRoleSchema = z.enum(["ADMIN", "FINANCE", "SUPERVISOR", "STAFF"]);
export type BaseRoleName = z.infer<typeof BaseRoleSchema>;

export const RoleScopeSchema = z.enum(["ORGANIZATION", "TENANT"]);
export type RoleScopeName = z.infer<typeof RoleScopeSchema>;

export const RoleAssignmentSchema = z.object({
  role: BaseRoleSchema,
  scope: RoleScopeSchema,
  tenantIds: z.array(z.string().uuid()),
});
export type RoleAssignmentDto = z.infer<typeof RoleAssignmentSchema>;

export const SessionUserSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid().nullable(),
  organizationId: z.string().uuid().nullable(),
  email: z.string().email(),
  displayName: z.string().nullable(),
  /** Base role names (or ["CUSTOMER"]). */
  roles: z.array(z.string()),
  roleAssignments: z.array(RoleAssignmentSchema),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

export const ConsoleLoginResponseSchema = z.object({
  accessToken: z.string(),
  user: SessionUserSchema,
});
export type ConsoleLoginResponse = z.infer<typeof ConsoleLoginResponseSchema>;

/** BUILD-SPEC C2 — staff user creation / role assignment (manage_users, admin only). */
export const CreateStaffUserRequestSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(1).max(120),
  password: z.string().min(8),
  role: BaseRoleSchema,
  /** ORGANIZATION scope is only grantable by an org-scoped admin (privilege guard, API-enforced). */
  scope: RoleScopeSchema,
});
export type CreateStaffUserRequest = z.infer<typeof CreateStaffUserRequestSchema>;

export const UpdateStaffRoleRequestSchema = z.object({
  role: BaseRoleSchema,
  scope: RoleScopeSchema,
});
export type UpdateStaffRoleRequest = z.infer<typeof UpdateStaffRoleRequestSchema>;

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
  phone: z.string().nullable(),
  email: z.string().nullable().optional(),
  fullName: z.string().nullable(),
});

/**
 * Magic link (PRD v2 §9): the token from a `/m/{token}` link in a WhatsApp
 * or email message, exchanged for a normal customer session — no OTP.
 */
export const MagicLinkExchangeSchema = z.object({
  token: z.string().min(16).max(200),
});
export type MagicLinkExchange = z.infer<typeof MagicLinkExchangeSchema>;

/**
 * Google sign-in via Clerk (PRD v2 D3/§9): the storefront sends Clerk's
 * session JWT; the API verifies it with Clerk's secret key, finds or
 * creates the customer by email, and issues our own JWT. Such customers
 * get EMAIL as their preferred channel.
 */
export const ClerkExchangeSchema = z.object({
  token: z.string().min(16),
  /** Optional WhatsApp number captured alongside, stored for the record (not used for messaging — D3). */
  phone: z.string().min(8).max(20).optional(),
});
export type ClerkExchange = z.infer<typeof ClerkExchangeSchema>;
export type CustomerSession = z.infer<typeof CustomerSessionSchema>;

export const CustomerAuthResponseSchema = z.object({
  accessToken: z.string(),
  customer: CustomerSessionSchema,
});
export type CustomerAuthResponse = z.infer<typeof CustomerAuthResponseSchema>;
