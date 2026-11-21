import type { Prisma, PrismaClient } from "../generated/client/index.js";

/**
 * The organization-wide messaging kill switch (PRD go-live §9.1).
 *
 * While `Organization.messagingPaused` is true, nothing outbound reaches a
 * provider: API notifications, the worker's dunning/renewal/reminder jobs,
 * the WhatsApp auto-reply and inbox replies all call `outboundBlock()` before
 * they send, and record what they WOULD have sent as a Notification with
 * status SUPPRESSED instead (`recordSuppressed`). Inbound messages still record.
 *
 * Every sender in the codebase goes through one of four functions —
 * NotificationsService.notify (API), notify() (worker),
 * WhatsAppWebhookService.autoReply and MessagingService.reply — and each of
 * them asks this module first. `packages/database/test/messaging-pause.test.ts`
 * scans the sources so a new sender that skips the check fails CI.
 *
 * The migration importer (§10) refuses to run unless messaging is paused.
 *
 * PRD go-live 2 §8.1 — the TEST ALLOWLIST is the second gate in the same
 * place. While `Organization.messagingAllowlistOnly` is true, a recipient that
 * is not on `Organization.messagingAllowlist` is suppressed exactly like a
 * paused send, with the code NOT_ON_TEST_ALLOWLIST. It exists for the client's
 * test period: the branch holds test renters and, after the final import, real
 * customers again — unpausing must not reach the real ones. That is why
 * `outboundBlock` REQUIRES the recipient: a sender cannot ask "may I send?"
 * without saying to whom. An e-mail address is never on the list (it holds
 * phone numbers), so e-mail is suppressed too while the toggle is on. An empty
 * list with the toggle on sends nothing — failing closed, like the pause.
 */

export interface MessagingPauseState {
  paused: boolean;
  reason: string | null;
  pausedAt: string | null;
  pausedByUserId: string | null;
}

export const SUPPRESSED_STATUS = "SUPPRESSED";

/**
 * Why a message was held back — the stable code stored on the SUPPRESSED row
 * (`notifications.suppression_code`) next to the human text (`error`).
 */
export type SuppressionCode = "PAUSED" | "NOT_ON_TEST_ALLOWLIST" | "UNKNOWN_TENANT";
export const SUPPRESSION_CODES: readonly SuppressionCode[] = ["PAUSED", "NOT_ON_TEST_ALLOWLIST", "UNKNOWN_TENANT"];

export interface OutboundBlock {
  code: SuppressionCode;
  /** Human-readable, for the log line, the agent's error and the suppressed list. */
  message: string;
}

export interface MessagingAllowlistState {
  /** "Hanya kirim ke nomor uji" — only numbers on the list are sent to. */
  enabled: boolean;
  /** E.164, e.g. +628111877838. */
  numbers: string[];
}

export const MESSAGING_ALLOWLIST_MAX = 50;

/**
 * One spelling per phone number, so "+62 811-1877-838", "628111877838" and
 * "08111877838" are the same recipient. Digits only, with the Indonesian
 * trunk "0" turned into the country code. Null for anything that is not a
 * phone number (an e-mail address, an empty string).
 */
export function recipientPhoneKey(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value || value.includes("@")) return null;
  const digits = value.replace(/\D/g, "");
  if (!digits) return null;
  const key = digits.startsWith("0") ? `62${digits.slice(1)}` : digits;
  return key.length >= 8 && key.length <= 15 ? key : null;
}

/** An allowlist entry as stored: E.164 with the plus. Null when it is not a phone number. */
export function normalizeAllowlistNumber(raw: string): string | null {
  const key = recipientPhoneKey(raw);
  return key ? `+${key}` : null;
}

function readAllowlist(org: { messagingAllowlist: unknown; messagingAllowlistOnly: boolean } | null | undefined): MessagingAllowlistState {
  const raw = Array.isArray(org?.messagingAllowlist) ? (org!.messagingAllowlist as unknown[]) : [];
  const numbers = [...new Set(raw.map((n) => (typeof n === "string" ? normalizeAllowlistNumber(n) : null)).filter((n): n is string => n !== null))];
  return { enabled: Boolean(org?.messagingAllowlistOnly), numbers };
}

/** Pure: is this recipient reachable under this allowlist state? */
export function allowlistPermits(state: MessagingAllowlistState, recipient: string | null | undefined): boolean {
  if (!state.enabled) return true;
  const key = recipientPhoneKey(recipient);
  return key !== null && state.numbers.some((n) => recipientPhoneKey(n) === key);
}

const ALLOWLIST_SELECT = { messagingAllowlist: true, messagingAllowlistOnly: true } as const;

export async function getMessagingAllowlist(prisma: PrismaClient | Prisma.TransactionClient, organizationId: string): Promise<MessagingAllowlistState> {
  return readAllowlist(await prisma.organization.findUnique({ where: { id: organizationId }, select: ALLOWLIST_SELECT }));
}

export class MessagingAllowlistError extends Error {}

/**
 * Replace the list and the toggle. Every entry must be a phone number;
 * duplicates (in any spelling) collapse. Organizations sit outside RLS.
 */
export async function setMessagingAllowlist(
  prisma: PrismaClient,
  organizationId: string,
  params: { enabled: boolean; numbers: readonly string[] },
): Promise<MessagingAllowlistState> {
  const numbers: string[] = [];
  for (const raw of params.numbers) {
    const n = normalizeAllowlistNumber(raw);
    if (!n) throw new MessagingAllowlistError(`"${raw}" is not a phone number. Use the international form, e.g. +628111877838.`);
    if (!numbers.includes(n)) numbers.push(n);
  }
  if (numbers.length > MESSAGING_ALLOWLIST_MAX) throw new MessagingAllowlistError(`At most ${MESSAGING_ALLOWLIST_MAX} test numbers.`);
  const org = await prisma.organization.update({
    where: { id: organizationId },
    data: { messagingAllowlist: numbers as unknown as Prisma.InputJsonValue, messagingAllowlistOnly: params.enabled },
    select: ALLOWLIST_SELECT,
  });
  return readAllowlist(org);
}

const ALLOWLIST_BLOCK_MESSAGE = "Test mode: this recipient is not on the test allowlist";

/**
 * The allowlist gate on its own, for the one sender the pause deliberately
 * lets through — the console's connection test (Settings → Messaging), which
 * goes to a number an admin types in. Null when the number may be sent to.
 */
export async function allowlistBlock(
  prisma: PrismaClient | Prisma.TransactionClient,
  organizationId: string,
  recipient: string | null | undefined,
): Promise<OutboundBlock | null> {
  const state = await getMessagingAllowlist(prisma, organizationId);
  return allowlistPermits(state, recipient) ? null : { code: "NOT_ON_TEST_ALLOWLIST", message: ALLOWLIST_BLOCK_MESSAGE };
}

function toState(org: {
  messagingPaused: boolean;
  messagingPausedReason: string | null;
  messagingPausedAt: Date | null;
  messagingPausedByUserId: string | null;
} | null): MessagingPauseState {
  return {
    paused: Boolean(org?.messagingPaused),
    reason: org?.messagingPausedReason ?? null,
    pausedAt: org?.messagingPausedAt?.toISOString() ?? null,
    pausedByUserId: org?.messagingPausedByUserId ?? null,
  };
}

const PAUSE_SELECT = {
  messagingPaused: true,
  messagingPausedReason: true,
  messagingPausedAt: true,
  messagingPausedByUserId: true,
} as const;

export async function getMessagingPause(prisma: PrismaClient | Prisma.TransactionClient, organizationId: string): Promise<MessagingPauseState> {
  return toState(await prisma.organization.findUnique({ where: { id: organizationId }, select: PAUSE_SELECT }));
}

/**
 * Null when sending to `recipient` may proceed; otherwise why not — the code
 * and the human-readable reason to store on the SUPPRESSED row.
 * `organizations`/`tenants` sit outside RLS, so this is a plain read that works
 * from any context. A tenant that cannot be resolved is treated as blocked:
 * failing closed is the point of a kill switch.
 *
 * Order: the pause wins. A message held back while paused is PAUSED whether or
 * not its number is on the test list, so the suppressed list reads the way the
 * operator thinks ("everything stopped"), and NOT_ON_TEST_ALLOWLIST only ever
 * marks a message that would otherwise have gone out.
 *
 * `recipient` is required on purpose (pass null only when there genuinely is
 * none): with the allowlist on, a send without a known recipient is blocked.
 */
export async function outboundBlock(
  prisma: PrismaClient | Prisma.TransactionClient,
  tenantId: string,
  recipient: string | null,
): Promise<OutboundBlock | null> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { organization: { select: { ...PAUSE_SELECT, ...ALLOWLIST_SELECT } } },
  });
  if (!tenant) return { code: "UNKNOWN_TENANT", message: "Messaging blocked: unknown tenant." };
  const state = toState(tenant.organization);
  if (state.paused) return { code: "PAUSED", message: `Messaging paused${state.reason ? `: ${state.reason}` : ""}` };
  if (!allowlistPermits(readAllowlist(tenant.organization), recipient)) {
    return { code: "NOT_ON_TEST_ALLOWLIST", message: ALLOWLIST_BLOCK_MESSAGE };
  }
  return null;
}

export async function setMessagingPause(
  prisma: PrismaClient,
  organizationId: string,
  params: { paused: boolean; reason?: string | null; userId: string },
): Promise<MessagingPauseState> {
  const org = await prisma.organization.update({
    where: { id: organizationId },
    data: params.paused
      ? {
          messagingPaused: true,
          messagingPausedReason: params.reason?.trim() || null,
          messagingPausedAt: new Date(),
          messagingPausedByUserId: params.userId,
        }
      : {
          messagingPaused: false,
          messagingPausedReason: null,
          messagingPausedAt: null,
          messagingPausedByUserId: null,
        },
    select: PAUSE_SELECT,
  });
  return toState(org);
}

/**
 * The trail a suppressed send leaves. Runs in the caller's tenant context
 * (`notifications` is RLS-scoped), so callers pass their own `tx`.
 */
export async function recordSuppressed(
  tx: Prisma.TransactionClient,
  params: {
    tenantId: string;
    customerId?: string | null;
    channel: "WHATSAPP" | "EMAIL";
    templateKey: string;
    recipient: string;
    recipientRole?: "CUSTOMER" | "ADMIN";
    payload: Record<string, unknown>;
    /** What `outboundBlock` returned. */
    reason: OutboundBlock;
  },
) {
  return tx.notification.create({
    data: {
      tenantId: params.tenantId,
      customerId: params.customerId ?? undefined,
      channel: params.channel,
      templateKey: params.templateKey,
      recipientRole: params.recipientRole ?? "CUSTOMER",
      recipient: params.recipient,
      payload: params.payload as Prisma.InputJsonValue,
      status: SUPPRESSED_STATUS,
      suppressionCode: params.reason.code,
      error: params.reason.message.slice(0, 500),
    },
  });
}
