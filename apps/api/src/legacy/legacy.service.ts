import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { LegacyImportRequest } from "@rentos/contracts";
import type { Prisma } from "@rentos/database";
import { can, hasOrganizationScope } from "@rentos/domain";

import { AuditService } from "../audit/audit.service.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import { PrismaService } from "../prisma/prisma.service.js";

const LIST_SELECT = {
  id: true,
  source: true,
  kind: true,
  number: true,
  customerId: true,
  customerNumber: true,
  customerName: true,
  occurredAt: true,
  amount: true,
  status: true,
  title: true,
} as const;

/**
 * The legacy archive (owner, 2026-11-12): everything the previous system
 * (Booqable) held, kept as it made it — a read-only backlog. Nothing here
 * touches the ledger, AR, document numbering or any job: RentOS's own books
 * start at the opening balances, and contracts made from go-live on are RentOS
 * documents. Records link to the RentOS customer when that customer exists.
 */
@Injectable()
export class LegacyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Upsert by (source, kind, legacyId) — re-running an import updates, never duplicates. */
  async importRecords(user: AuthenticatedUser, tenantId: string, body: LegacyImportRequest) {
    if (!hasOrganizationScope(user.roleAssignments) || !can(user.roleAssignments, "manage_users")) {
      throw new ForbiddenException("Only an organization-scoped Admin can import legacy records.");
    }
    for (const r of body.records) {
      if (r.occurredAt && Number.isNaN(new Date(r.occurredAt).getTime())) throw new BadRequestException(`Record ${r.kind}/${r.legacyId}: occurredAt is not a date.`);
    }
    const customers = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.customer.findMany({ where: { customerNumber: { not: null } }, select: { id: true, customerNumber: true } }),
    );
    const customerId = new Map(customers.map((c) => [c.customerNumber!, c.id]));
    const result = { created: 0, updated: 0 };
    // A hundred records per transaction: bounded locks, and a failed chunk
    // leaves earlier ones in place (the import is an idempotent upsert).
    for (let i = 0; i < body.records.length; i += 100) {
      const chunk = body.records.slice(i, i + 100);
      await this.prisma.runInTenantContext(
        tenantId,
        async (tx) => {
          const existing = await tx.legacyRecord.findMany({
            where: { source: body.source, OR: chunk.map((r) => ({ kind: r.kind, legacyId: r.legacyId })) },
            select: { kind: true, legacyId: true },
          });
          const known = new Set(existing.map((e) => `${e.kind}/${e.legacyId}`));
          for (const r of chunk) {
            const fields = {
              number: r.number ?? null,
              customerId: r.customerNumber != null ? (customerId.get(r.customerNumber) ?? null) : null,
              customerNumber: r.customerNumber ?? null,
              customerName: r.customerName ?? null,
              occurredAt: r.occurredAt ? new Date(r.occurredAt) : null,
              amount: r.amount != null ? r.amount.toFixed(2) : null,
              status: r.status ?? null,
              title: r.title?.slice(0, 300) ?? null,
              data: r.data as Prisma.InputJsonValue,
            };
            await tx.legacyRecord.upsert({
              where: { tenantId_source_kind_legacyId: { tenantId, source: body.source, kind: r.kind, legacyId: r.legacyId } },
              create: { tenantId, source: body.source, kind: r.kind, legacyId: r.legacyId, ...fields },
              update: fields,
            });
            if (known.has(`${r.kind}/${r.legacyId}`)) result.updated++;
            else result.created++;
          }
        },
        { timeout: 60_000, maxWait: 15_000 },
      );
    }
    await this.audit.record({
      tenantId,
      actorUserId: user.id,
      action: "LEGACY_RECORDS_IMPORTED",
      entityType: "LegacyRecord",
      metadata: { source: body.source, ...result },
    });
    return result;
  }

  /** Counts per kind, for the archive's tabs (and per customer for the client page). */
  async summary(tenantId: string, customerNumber?: number) {
    const rows = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.legacyRecord.groupBy({
        by: ["kind"],
        where: { kind: { not: "TEXT" }, ...(customerNumber != null ? { customerNumber } : {}) },
        _count: { _all: true },
        _sum: { amount: true },
      }),
    );
    return rows.map((r) => ({ kind: r.kind, count: r._count._all, amount: r._sum.amount?.toString() ?? null }));
  }

  async list(tenantId: string, q: { kind?: string; customerNumber?: number; search?: string; page: number; pageSize: number }) {
    const search = q.search?.trim();
    const where: Prisma.LegacyRecordWhereInput = {
      kind: q.kind ?? { not: "TEXT" },
      ...(q.customerNumber != null ? { customerNumber: q.customerNumber } : {}),
      ...(search
        ? {
            OR: [
              { number: { contains: search, mode: "insensitive" } },
              { customerName: { contains: search, mode: "insensitive" } },
              { title: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const [total, items] = await Promise.all([
        tx.legacyRecord.count({ where }),
        tx.legacyRecord.findMany({
          where,
          select: LIST_SELECT,
          orderBy: [{ occurredAt: { sort: "desc", nulls: "last" } }, { number: "desc" }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        }),
      ]);
      return { total, page: q.page, pageSize: q.pageSize, items: items.map((i) => ({ ...i, amount: i.amount?.toString() ?? null })) };
    });
  }

  /** One record in full. A document's shared text (contract terms, footer) is resolved from its TEXT record. */
  async get(tenantId: string, id: string) {
    return this.prisma.runInTenantContext(tenantId, async (tx) => {
      const record = await tx.legacyRecord.findUnique({ where: { id } });
      if (!record || record.kind === "TEXT") throw new NotFoundException("Legacy record not found.");
      const data = (record.data ?? {}) as { bodyRef?: string | null; footerRef?: string | null };
      const refs = [data.bodyRef, data.footerRef].filter((r): r is string => Boolean(r));
      const texts = refs.length
        ? await tx.legacyRecord.findMany({ where: { source: record.source, kind: "TEXT", legacyId: { in: refs } }, select: { legacyId: true, data: true } })
        : [];
      const html = (ref?: string | null) => (ref ? ((texts.find((t) => t.legacyId === ref)?.data as { html?: string } | undefined)?.html ?? null) : null);
      return { ...record, amount: record.amount?.toString() ?? null, bodyHtml: html(data.bodyRef), footerHtml: html(data.footerRef) };
    });
  }
}
