import { Injectable } from "@nestjs/common";
import type { ExternalListQuery } from "@rentos/contracts";

import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

/** Read-only, cursor-paginated (Booking.id / Invoice.id ordering — UUIDv4 has no natural order, but stability across pages only requires a fixed total order, not a meaningful one). */
@Injectable()
export class ExternalApiService {
  constructor(private readonly prisma: PrismaService) {}

  async listBookings(tenant: ResolvedTenant, query: ExternalListQuery) {
    const rows = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.booking.findMany({
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        orderBy: { id: "asc" },
      }),
    );
    return paginate(rows, query.limit);
  }

  async listInvoices(tenant: ResolvedTenant, query: ExternalListQuery) {
    const rows = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.invoice.findMany({
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
        orderBy: { id: "asc" },
        include: { lines: true },
      }),
    );
    return paginate(rows, query.limit);
  }
}

function paginate<T extends { id: string }>(rows: T[], limit: number): { data: T[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  return { data, nextCursor: hasMore ? data[data.length - 1]!.id : null };
}
