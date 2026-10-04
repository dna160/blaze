import { BadRequestException, ConflictException, Inject, Injectable, Logger, BadGatewayException } from "@nestjs/common";
import {
  isReplyWindowOpen,
  messageDirection,
  messageKind,
  normalizePhone,
  replyWindowClosesAt,
  type ConversationListResponse,
  type ConversationSummary,
  type ThreadMessage,
  type ThreadResponse,
} from "@rentos/contracts";
import { resolveMessagingConfig } from "@rentos/database";
import { hasOrganizationScope } from "@rentos/domain";

import { MESSAGING_PROVIDERS, type MessagingProviderRegistry } from "../notifications/messaging-provider.interface.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";

/** Only rows on this channel/role form a customer conversation; admin dunning copies are not threads. */
const CONVERSATION_SCOPE = { channel: "WHATSAPP", recipientRole: "CUSTOMER" } as const;

interface ConversationRow {
  phone: string;
  last_at: Date;
  last_inbound_at: Date | null;
  unread_count: bigint;
  template_key: string;
  status: string;
  payload: Record<string, unknown>;
  customer_id: string | null;
  customer_name: string | null;
  profile_name: string | null;
}

/**
 * The console's WhatsApp inbox.
 *
 * A conversation is derived rather than stored: every notification row for one
 * `(tenant, counterpart phone)` pair, in time order. That keeps one trail per
 * customer — the webhook's inbound rows, the auto-reply, agent replies and any
 * template send all land in the same place — at the cost of a grouped query
 * instead of a table read.
 *
 * Branch scope is enforced the same way the rest of the back office does it:
 * every statement runs inside `runInTenantContext`, so RLS decides what is
 * visible rather than a `where` clause anyone could forget. A user scoped to one
 * branch sees that branch's conversations and gets zero rows for a sibling's,
 * not a 403 — the sibling's existence is not theirs to learn.
 */
@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MESSAGING_PROVIDERS) private readonly providers: MessagingProviderRegistry,
  ) {}

  /**
   * The branches this user may read. Mirrors OrganizationService.listBranches:
   * org-scoped roles see the whole organization, tenant-scoped roles see only
   * the branches their assignments name. `tenants` sits outside RLS (it is the
   * bootstrap registry), so this raw read is the sanctioned one.
   */
  private async visibleTenants(user: AuthenticatedUser): Promise<Array<{ id: string; name: string }>> {
    if (!user.organizationId) {
      if (!user.tenantId) return [];
      const solo = await this.prisma.raw.tenant.findUnique({
        where: { id: user.tenantId },
        select: { id: true, name: true },
      });
      return solo ? [solo] : [];
    }
    const all = await this.prisma.raw.tenant.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    if (hasOrganizationScope(user.roleAssignments)) return all;
    const allowed = new Set(user.roleAssignments.flatMap((r) => r.tenantIds));
    return all.filter((t) => allowed.has(t.id));
  }

  /** Narrow the branch set to one tenant, refusing anything outside the user's scope. */
  private async assertTenant(user: AuthenticatedUser, tenantId: string): Promise<{ id: string; name: string }> {
    const tenant = (await this.visibleTenants(user)).find((t) => t.id === tenantId);
    // Deliberately the same answer as a tenant that does not exist.
    if (!tenant) throw new BadRequestException("Unknown branch.");
    return tenant;
  }

  /**
   * One grouped query per branch rather than loading rows and folding them in
   * JavaScript, because a busy number's history is unbounded while the number of
   * conversations is not.
   *
   * `ltrim(recipient,'+')` is the normalisation: Meta sends `6281…`, customers
   * are stored `+6281…`, and both must collapse to one thread.
   */
  private async conversationsForTenant(tenantId: string, q: string | undefined): Promise<ConversationRow[]> {
    const like = q?.trim() ? `%${q.trim()}%` : null;
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.$queryRaw<ConversationRow[]>`
        WITH conv AS (
          SELECT ltrim(recipient, '+') AS phone,
                 max(created_at) AS last_at,
                 max(created_at) FILTER (WHERE template_key = 'inbound_message') AS last_inbound_at,
                 count(*) FILTER (WHERE template_key = 'inbound_message' AND read_at IS NULL) AS unread_count,
                 (array_agg(payload->>'profileName' ORDER BY created_at DESC)
                    FILTER (WHERE template_key = 'inbound_message' AND payload->>'profileName' IS NOT NULL))[1]
                   AS profile_name
          FROM notifications
          WHERE channel = 'WHATSAPP' AND recipient_role = 'CUSTOMER'
          GROUP BY 1
        ),
        latest AS (
          SELECT DISTINCT ON (ltrim(recipient, '+'))
                 ltrim(recipient, '+') AS phone,
                 template_key, status, payload, customer_id
          FROM notifications
          WHERE channel = 'WHATSAPP' AND recipient_role = 'CUSTOMER'
          ORDER BY ltrim(recipient, '+'), created_at DESC
        )
        SELECT c.phone, c.last_at, c.last_inbound_at, c.unread_count, c.profile_name,
               l.template_key, l.status, l.payload, l.customer_id,
               cu.full_name AS customer_name
        FROM conv c
        JOIN latest l ON l.phone = c.phone
        LEFT JOIN customers cu ON cu.id = l.customer_id
        WHERE ${like}::text IS NULL
           OR c.phone ILIKE ${like}
           OR coalesce(cu.full_name, c.profile_name) ILIKE ${like}
        ORDER BY c.last_at DESC
      `,
    );
  }

  async listConversations(
    user: AuthenticatedUser,
    opts: { tenantId?: string; q?: string; unreadOnly?: boolean; cursor?: string; limit?: number },
  ): Promise<ConversationListResponse> {
    const tenants = opts.tenantId
      ? [await this.assertTenant(user, opts.tenantId)]
      : await this.visibleTenants(user);

    const all: ConversationSummary[] = [];
    for (const tenant of tenants) {
      for (const row of await this.conversationsForTenant(tenant.id, opts.q)) {
        all.push({
          tenantId: tenant.id,
          tenantName: tenant.name,
          phone: row.phone,
          displayName: row.customer_name ?? row.profile_name ?? null,
          customer: row.customer_id ? { id: row.customer_id, fullName: row.customer_name } : null,
          lastMessage: {
            text: typeof row.payload?.text === "string" ? row.payload.text : row.template_key,
            direction: messageDirection(row.template_key),
            at: row.last_at.toISOString(),
            status: row.status,
          },
          lastInboundAt: row.last_inbound_at ? row.last_inbound_at.toISOString() : null,
          unreadCount: Number(row.unread_count),
        });
      }
    }

    // Branches are queried separately, so ordering across them happens here. The
    // cursor is the previous page's last (timestamp, phone) pair, which is
    // stable under new arrivals: a conversation that jumps to the top reappears
    // at the top rather than being skipped mid-scroll.
    all.sort((a, b) => b.lastMessage.at.localeCompare(a.lastMessage.at) || a.phone.localeCompare(b.phone));

    const totalUnread = all.reduce((sum, c) => sum + c.unreadCount, 0);
    const filtered = opts.unreadOnly ? all.filter((c) => c.unreadCount > 0) : all;

    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const start = opts.cursor ? filtered.findIndex((c) => `${c.lastMessage.at}|${c.phone}` === opts.cursor) + 1 : 0;
    const page = filtered.slice(start, start + limit);
    const last = page[page.length - 1];
    const nextCursor =
      last && start + limit < filtered.length ? `${last.lastMessage.at}|${last.phone}` : null;

    return { items: page, nextCursor, totalUnread };
  }

  /**
   * The thread, plus the side effect that opening it is what "read" means —
   * there is no separate mark-read call to forget. The Meta read receipt is
   * best-effort on top of that: the local state is what the console renders.
   */
  async thread(
    user: AuthenticatedUser,
    tenantId: string,
    phoneInput: string,
    opts: { before?: string; limit?: number },
  ): Promise<ThreadResponse> {
    await this.assertTenant(user, tenantId);
    const phone = normalizePhone(phoneInput);
    if (!phone) throw new BadRequestException("A phone number is required.");
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

    const { rows, customer, unreadRefs, lastInboundAt } = await this.prisma.runInTenantContext(tenantId, async (tx) => {
      // Newest-first with the limit, reversed below: paging backwards through
      // history is what `before` is for, and the page must be the newest slice.
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          template_key: string;
          status: string;
          error: string | null;
          provider_ref: string | null;
          payload: Record<string, unknown>;
          created_at: Date;
          read_at: Date | null;
          customer_id: string | null;
        }>
      >`
        SELECT id, template_key, status, error, provider_ref, payload, created_at, read_at, customer_id
        FROM notifications
        WHERE channel = 'WHATSAPP' AND recipient_role = 'CUSTOMER'
          AND ltrim(recipient, '+') = ${phone}
          AND (${opts.before ?? null}::timestamptz IS NULL OR created_at < ${opts.before ?? null}::timestamptz)
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;

      const customerId = rows.find((r) => r.customer_id)?.customer_id ?? null;
      const customer = customerId
        ? await tx.customer.findUnique({
            where: { id: customerId },
            select: { id: true, fullName: true, phone: true },
          })
        : null;

      // The window is a property of the whole conversation, not of this page.
      const windowRow = await tx.$queryRaw<Array<{ last_inbound_at: Date | null }>>`
        SELECT max(created_at) AS last_inbound_at
        FROM notifications
        WHERE channel = 'WHATSAPP' AND recipient_role = 'CUSTOMER'
          AND template_key = 'inbound_message' AND ltrim(recipient, '+') = ${phone}
      `;

      const unread = await tx.notification.findMany({
        where: { templateKey: "inbound_message", readAt: null, recipient: { in: [phone, `+${phone}`] } },
        select: { id: true, providerRef: true, createdAt: true },
        orderBy: { createdAt: "desc" },
      });
      if (unread.length > 0) {
        await tx.notification.updateMany({ where: { id: { in: unread.map((u) => u.id) } }, data: { readAt: new Date() } });
      }

      return {
        rows,
        customer,
        unreadRefs: unread.map((u) => u.providerRef).filter((r): r is string => Boolean(r)),
        lastInboundAt: windowRow[0]?.last_inbound_at ?? null,
      };
    });

    // Only the newest unread needs acknowledging — WhatsApp marks everything
    // before it read too, so one call is both sufficient and cheapest.
    if (unreadRefs[0]) void this.sendReadReceipt(tenantId, unreadRefs[0]);

    const messages: ThreadMessage[] = rows
      .slice()
      .reverse()
      .map((r) => ({
        id: r.id,
        direction: messageDirection(r.template_key),
        kind: messageKind(r.template_key, r.payload ?? {}),
        text: typeof r.payload?.text === "string" ? r.payload.text : r.template_key,
        templateKey: r.template_key,
        status: r.status,
        error: r.error,
        providerRef: r.provider_ref,
        at: r.created_at.toISOString(),
        payload: r.payload ?? {},
      }));

    const closesAt = replyWindowClosesAt(lastInboundAt);
    return {
      messages,
      customer: customer ? { id: customer.id, fullName: customer.fullName, phone: customer.phone } : null,
      windowOpenUntil: closesAt ? closesAt.toISOString() : null,
      canReply: isReplyWindowOpen(lastInboundAt),
    };
  }

  private async sendReadReceipt(tenantId: string, providerRef: string): Promise<void> {
    try {
      const config = await resolveMessagingConfig(this.prisma.raw, tenantId);
      await this.providers[config.provider].markRead(providerRef, config);
    } catch (err) {
      this.logger.warn(`Read receipt for ${providerRef} failed: ${(err as Error).message}`);
    }
  }

  /**
   * Free-form reply. The window is checked here rather than letting Meta refuse,
   * so the customer-facing failure (a message that silently never arrives) is
   * turned into a precise answer the console can render — and so a doomed send
   * is not recorded as attempted.
   */
  async reply(user: AuthenticatedUser, tenantId: string, phoneInput: string, text: string): Promise<ThreadMessage> {
    await this.assertTenant(user, tenantId);
    const phone = normalizePhone(phoneInput);
    if (!phone) throw new BadRequestException("A phone number is required.");

    const lastInboundAt = await this.prisma.runInTenantContext(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ last_inbound_at: Date | null }>>`
        SELECT max(created_at) AS last_inbound_at
        FROM notifications
        WHERE channel = 'WHATSAPP' AND recipient_role = 'CUSTOMER'
          AND template_key = 'inbound_message' AND ltrim(recipient, '+') = ${phone}
      `;
      return rows[0]?.last_inbound_at ?? null;
    });

    if (!isReplyWindowOpen(lastInboundAt)) {
      const closesAt = replyWindowClosesAt(lastInboundAt);
      throw new ConflictException({
        code: "WINDOW_CLOSED",
        windowOpenUntil: closesAt ? closesAt.toISOString() : null,
        message: lastInboundAt
          ? "The 24-hour reply window has closed. The customer must message again before you can reply."
          : "This customer has never messaged you, so there is no reply window open.",
      });
    }

    const config = await resolveMessagingConfig(this.prisma.raw, tenantId);
    let providerRef: string;
    try {
      const result = await this.providers[config.provider].sendText({ to: phone, text }, config);
      providerRef = result.providerRef;
    } catch (err) {
      // Meta's own words, verbatim: 131030 ("not in allowed list") on a test
      // number and 131047 (window) are self-explanatory to whoever set the
      // number up, and paraphrasing them would only lose information.
      throw new BadGatewayException((err as Error).message);
    }

    const customerId = await this.prisma.runInTenantContext(tenantId, async (tx) => {
      const row = await tx.notification.findFirst({
        where: { recipient: { in: [phone, `+${phone}`] }, customerId: { not: null } },
        select: { customerId: true },
        orderBy: { createdAt: "desc" },
      });
      return row?.customerId ?? null;
    });

    const created = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.notification.create({
        data: {
          tenantId,
          customerId: customerId ?? undefined,
          channel: "WHATSAPP",
          templateKey: "agent_reply",
          recipientRole: CONVERSATION_SCOPE.recipientRole,
          recipient: phone,
          payload: { text, sentBy: user.id },
          status: "SENT",
          providerRef,
          sentAt: new Date(),
        },
      }),
    );

    return {
      id: created.id,
      direction: "out",
      kind: "text",
      text,
      templateKey: created.templateKey,
      status: created.status,
      error: null,
      providerRef: created.providerRef,
      at: created.createdAt.toISOString(),
      payload: { text, sentBy: user.id },
    };
  }

  /** Nav badge. Counts unread inbound across every branch the user can see. */
  async unreadCount(user: AuthenticatedUser): Promise<{ count: number }> {
    let count = 0;
    for (const tenant of await this.visibleTenants(user)) {
      count += await this.prisma.runInTenantContext(tenant.id, (tx) =>
        tx.notification.count({
          where: { channel: "WHATSAPP", recipientRole: "CUSTOMER", templateKey: "inbound_message", readAt: null },
        }),
      );
    }
    return { count };
  }
}
