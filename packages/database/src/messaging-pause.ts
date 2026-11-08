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
 */

export interface MessagingPauseState {
  paused: boolean;
  reason: string | null;
  pausedAt: string | null;
  pausedByUserId: string | null;
}

export const SUPPRESSED_STATUS = "SUPPRESSED";

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
 * Null when sending may proceed; otherwise the human-readable reason to store
 * on the SUPPRESSED row. `organizations`/`tenants` sit outside RLS, so this is
 * a plain read that works from any context. A tenant that cannot be resolved
 * is treated as paused: failing closed is the point of a kill switch.
 */
export async function outboundBlock(prisma: PrismaClient | Prisma.TransactionClient, tenantId: string): Promise<string | null> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { organization: { select: PAUSE_SELECT } },
  });
  if (!tenant) return "Messaging blocked: unknown tenant.";
  const state = toState(tenant.organization);
  if (!state.paused) return null;
  return `Messaging paused${state.reason ? `: ${state.reason}` : ""}`;
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
    reason: string;
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
      error: params.reason.slice(0, 500),
    },
  });
}
