import { z } from "zod";

/**
 * #40 — org-level messaging setup, configured from the console instead of a
 * deployment's environment. One WhatsApp number serves every branch in the
 * organization.
 */
export const MessagingProviderSchema = z.enum(["console_log", "whatsapp_cloud"]);
export type MessagingProviderName = z.infer<typeof MessagingProviderSchema>;

export const MessagingConfigResponseSchema = z.object({
  provider: MessagingProviderSchema,
  phoneNumberId: z.string().nullable(),
  businessAccountId: z.string().nullable(),
  /** Last 4 characters of the saved token — enough to tell two credentials apart, useless on its own. */
  accessTokenHint: z.string().nullable(),
  hasAccessToken: z.boolean(),
  updatedAt: z.string().nullable(),
  updatedByUserId: z.string().nullable(),
  /** Which credentials are actually in force: the saved org config, the deployment environment, or neither. */
  source: z.enum(["organization", "environment", "default"]),
  /** False when MESSAGING_CONFIG_KEY is unset — the screen can then explain why saving a token is refused. */
  canStoreSecrets: z.boolean(),
});
export type MessagingConfigResponse = z.infer<typeof MessagingConfigResponseSchema>;

export const UpdateMessagingConfigRequestSchema = z
  .object({
    provider: MessagingProviderSchema,
    phoneNumberId: z.string().trim().min(1).max(64).nullable().optional(),
    businessAccountId: z.string().trim().min(1).max(64).nullable().optional(),
    /** Omit to keep the stored token; send a new value to replace it. Never returned by any read. */
    accessToken: z.string().trim().min(20).max(1024).nullable().optional(),
  })
  .refine((v) => v.provider !== "whatsapp_cloud" || Boolean(v.phoneNumberId), {
    message: "A phone number ID is required to send through WhatsApp Cloud.",
    path: ["phoneNumberId"],
  });
export type UpdateMessagingConfigRequest = z.infer<typeof UpdateMessagingConfigRequestSchema>;

/**
 * Test send. `accessToken`/`phoneNumberId` are optional overrides so a
 * credential can be proven BEFORE it is saved; omitted, the saved config is
 * used. The result is not recorded as a customer Notification.
 */
export const TestMessagingRequestSchema = z.object({
  to: z.string().trim().min(8).max(20),
  phoneNumberId: z.string().trim().min(1).max(64).optional(),
  accessToken: z.string().trim().min(20).max(1024).optional(),
});
export type TestMessagingRequest = z.infer<typeof TestMessagingRequestSchema>;

export const TestMessagingResponseSchema = z.object({
  ok: z.boolean(),
  provider: MessagingProviderSchema,
  providerRef: z.string().nullable(),
  error: z.string().nullable(),
});
export type TestMessagingResponse = z.infer<typeof TestMessagingResponseSchema>;
