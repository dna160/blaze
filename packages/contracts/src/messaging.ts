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
  /** Auto-reply to inbound WhatsApp messages. Free-form, so no approved template is needed. */
  autoReplyEnabled: z.boolean(),
  autoReplyText: z.string().nullable(),
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
    autoReplyEnabled: z.boolean().optional(),
    autoReplyText: z.string().trim().max(1000).nullable().optional(),
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

/* ------------------------------------------------------------------ inbox */

/**
 * Messaging inbox. A conversation is derived, not stored: it is every WhatsApp
 * notification row for one `(tenantId, counterpart phone)` pair. Meta reports
 * numbers without a leading `+` while customers are stored with one, so the
 * phone is normalised to Meta's spelling everywhere in these shapes.
 */
export const MessageDirectionSchema = z.enum(["in", "out"]);
export type MessageDirection = z.infer<typeof MessageDirectionSchema>;

/** What the thread shows for a row. Derived from templateKey/payload, never stored. */
export const MessageKindSchema = z.enum(["text", "template", "auto_reply", "media", "other"]);
export type MessageKind = z.infer<typeof MessageKindSchema>;

export const ConversationSummarySchema = z.object({
  tenantId: z.string().uuid(),
  tenantName: z.string(),
  phone: z.string(),
  displayName: z.string().nullable(),
  customer: z.object({ id: z.string().uuid(), fullName: z.string().nullable() }).nullable(),
  lastMessage: z.object({
    text: z.string(),
    direction: MessageDirectionSchema,
    at: z.string().datetime(),
    status: z.string(),
  }),
  /** Drives the 24-hour reply window. Null when the customer has never written in. */
  lastInboundAt: z.string().datetime().nullable(),
  unreadCount: z.number().int().nonnegative(),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

export const ConversationListResponseSchema = z.object({
  items: z.array(ConversationSummarySchema),
  nextCursor: z.string().nullable(),
  totalUnread: z.number().int().nonnegative(),
});
export type ConversationListResponse = z.infer<typeof ConversationListResponseSchema>;

export const ThreadMessageSchema = z.object({
  id: z.string().uuid(),
  direction: MessageDirectionSchema,
  kind: MessageKindSchema,
  text: z.string(),
  templateKey: z.string(),
  status: z.string(),
  error: z.string().nullable(),
  providerRef: z.string().nullable(),
  at: z.string().datetime(),
  payload: z.record(z.unknown()),
});
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;

export const ThreadResponseSchema = z.object({
  messages: z.array(ThreadMessageSchema),
  customer: z
    .object({ id: z.string().uuid(), fullName: z.string().nullable(), phone: z.string().nullable() })
    .nullable(),
  /** `lastInboundAt + 24h`. Null when no inbound has ever arrived. */
  windowOpenUntil: z.string().datetime().nullable(),
  /** Whether free-form reply is permitted right now. The server enforces this too. */
  canReply: z.boolean(),
});
export type ThreadResponse = z.infer<typeof ThreadResponseSchema>;

export const SendReplyRequestSchema = z.object({
  text: z.string().trim().min(1).max(4096),
});
export type SendReplyRequest = z.infer<typeof SendReplyRequestSchema>;

export const UnreadCountResponseSchema = z.object({ count: z.number().int().nonnegative() });
export type UnreadCountResponse = z.infer<typeof UnreadCountResponseSchema>;

/** WhatsApp's customer service window: free-form replies are allowed for 24h after the customer writes. */
export const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Meta reports `6281…`; customers are stored `+6281…`. One conversation, so a
 * single spelling is used as the key everywhere — Meta's, since that is what
 * arrives on the wire and what must be sent back.
 */
export function normalizePhone(value: string): string {
  return value.replace(/[^\d]/g, "");
}

/** Both spellings of a number, for matching against stored customer phones. */
export function phoneCandidates(value: string): string[] {
  const digits = normalizePhone(value);
  return [digits, `+${digits}`];
}

/**
 * Is the free-form reply window open? Exactly 24h after the last inbound counts
 * as closed — the boundary belongs to the closed side, because a reply Meta
 * rejects is worse than one the UI declined to send.
 */
export function isReplyWindowOpen(lastInboundAt: Date | string | null, now: Date = new Date()): boolean {
  if (!lastInboundAt) return false;
  const last = typeof lastInboundAt === "string" ? new Date(lastInboundAt) : lastInboundAt;
  return now.getTime() - last.getTime() < CUSTOMER_SERVICE_WINDOW_MS;
}

/** When the window shuts, or null if it never opened. */
export function replyWindowClosesAt(lastInboundAt: Date | string | null): Date | null {
  if (!lastInboundAt) return null;
  const last = typeof lastInboundAt === "string" ? new Date(lastInboundAt) : lastInboundAt;
  return new Date(last.getTime() + CUSTOMER_SERVICE_WINDOW_MS);
}

/** Inbound rows are the ones the webhook wrote; everything else on the pair was sent by us. */
export function messageDirection(templateKey: string): MessageDirection {
  return templateKey === "inbound_message" ? "in" : "out";
}

/** How the thread should render a row. */
export function messageKind(templateKey: string, payload: Record<string, unknown>): MessageKind {
  if (templateKey === "inbound_message") return payload.mediaId ? "media" : "text";
  if (templateKey === "auto_reply") return "auto_reply";
  if (templateKey === "agent_reply") return "text";
  return "template";
}
