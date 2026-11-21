import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AmendChangeRequest,
  ApprovalPolicyDto,
  AvailableUnitsForDateDto,
  ChangeRequestDto,
  ChangeRequestListQuery,
  ChangeRequestOptionsDto,
  ChangeRequestSummaryDto,
  CreateChangeRequest,
  DecideChangeRequest,
  SignedContractHandling,
  UpdateApprovalPolicy,
} from "@rentos/contracts";
import { zonedDateString } from "@rentos/contracts";
import { listAvailableStorageAssets, resolveBlackoutMonths, withOrgReadContext, type Prisma } from "@rentos/database";
import {
  approvableChangeTypes,
  can,
  checkChangeDecision,
  DEFAULT_APPROVAL_POLICY,
  resolveApprovalPolicy,
  selfApprovesOnRequest,
  type ApprovalPolicy,
  type ChangeRequestType,
} from "@rentos/domain";

import { AuditService } from "../audit/audit.service.js";
import { BookingService, CANCELLABLE_STATUSES, START_DATE_CHANGEABLE_STATUSES } from "../booking/booking.service.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

interface DateChangePayload {
  newStartDate?: string;
  assetId?: string | null;
  signedContract?: SignedContractHandling;
  previousStartDate?: string;
  previousAssetId?: string | null;
}

const SELF_APPROVED_NOTE = "Disetujui otomatis — pembatalan oleh Super Admin (satu langkah).";

const isoDay = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
const dayToDate = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const REQUEST_INCLUDE = {
  booking: {
    include: {
      customer: { select: { id: true, fullName: true, companyName: true, customerNumber: true } },
      asset: { select: { id: true, code: true } },
      assetType: { select: { name: true } },
      contracts: { orderBy: { createdAt: "desc" as const }, take: 1, select: { contractNumber: true, signedAt: true } },
    },
  },
} satisfies Prisma.ChangeRequestInclude;

type RequestRow = Prisma.ChangeRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

/**
 * PRD go-live 2 §4 — booking changes need approval.
 *
 * This service owns the REQUEST: who may file one, who may decide it (the
 * organization's approval policy + maker-checker), and its audit trail. What an
 * approval DOES lives in BookingService (`cancelBooking`, `changeStartDate`) —
 * the same code the direct cancel ran before, now reachable only from here.
 */
@Injectable()
export class ChangeRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ policy

  private async policyFor(tenant: ResolvedTenant): Promise<ApprovalPolicy> {
    const org = await this.prisma.raw.organization.findUnique({ where: { id: tenant.organizationId }, select: { approvalPolicy: true } });
    return resolveApprovalPolicy(org?.approvalPolicy);
  }

  private isSuperAdmin(user: AuthenticatedUser): boolean {
    return user.roleAssignments.some((r) => r.role === "ADMIN" && r.scope === "ORGANIZATION");
  }

  async getPolicy(user: AuthenticatedUser, tenant: ResolvedTenant): Promise<ApprovalPolicyDto> {
    const policy = await this.policyFor(tenant);
    const plain = (p: ApprovalPolicy) => ({
      CANCEL: { roles: [...p.CANCEL.roles], scope: p.CANCEL.scope },
      CHANGE_START_DATE: { roles: [...p.CHANGE_START_DATE.roles], scope: p.CHANGE_START_DATE.scope },
    });
    return { policy: plain(policy), defaults: plain(DEFAULT_APPROVAL_POLICY), canEdit: this.isSuperAdmin(user) };
  }

  /** §12 Q2 — a settings edit, by the super admin only: this decides who can cancel bookings in every branch. */
  async updatePolicy(user: AuthenticatedUser, tenant: ResolvedTenant, body: UpdateApprovalPolicy): Promise<ApprovalPolicyDto> {
    if (!this.isSuperAdmin(user)) throw new ForbiddenException("Hanya Super Admin yang dapat mengubah siapa yang menyetujui permintaan.");
    const org = await this.prisma.raw.organization.findUniqueOrThrow({ where: { id: tenant.organizationId }, select: { approvalPolicy: true } });
    const before = (org.approvalPolicy ?? {}) as Record<string, unknown>;
    const next = { ...before, ...(body.CANCEL ? { CANCEL: body.CANCEL } : {}), ...(body.CHANGE_START_DATE ? { CHANGE_START_DATE: body.CHANGE_START_DATE } : {}) };
    await this.prisma.raw.organization.update({ where: { id: tenant.organizationId }, data: { approvalPolicy: next as Prisma.InputJsonValue } });
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId: user.id,
      action: "APPROVAL_POLICY_UPDATED",
      entityType: "Organization",
      entityId: tenant.organizationId,
      metadata: { from: before, to: next },
    });
    return this.getPolicy(user, tenant);
  }

  // ----------------------------------------------------------------- reading

  async summary(user: AuthenticatedUser, tenant: ResolvedTenant): Promise<ChangeRequestSummaryDto> {
    const policy = await this.policyFor(tenant);
    const approvableTypes = approvableChangeTypes(user.roleAssignments, tenant.id, policy);
    const pendingForMe =
      approvableTypes.length === 0
        ? 0
        : await this.prisma.runInTenantContext(tenant.id, (tx) =>
            tx.changeRequest.count({ where: { status: "PENDING", type: { in: approvableTypes }, requestedByUserId: { not: user.id } } }),
          );
    return { pendingForMe, approvableTypes, canRequest: can(user.roleAssignments, "request_booking_change", tenant.id) };
  }

  /** What the request form needs to know about one booking. */
  async options(user: AuthenticatedUser, tenant: ResolvedTenant, bookingId: string): Promise<ChangeRequestOptionsDto> {
    const policy = await this.policyFor(tenant);
    const booking = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.booking.findUnique({
        where: { id: bookingId },
        include: {
          asset: { select: { code: true } },
          contracts: { orderBy: { createdAt: "desc" }, take: 1, select: { signedAt: true } },
          changeRequests: { where: { status: "PENDING" }, select: { id: true, type: true } },
        },
      }),
    );
    if (!booking) throw new NotFoundException("Booking tidak ditemukan.");
    const cancelBlocked = await this.bookings.cancellationBlocker(tenant.id, bookingId);
    const dateBlocked = await this.bookings.startDateChangeBlocker(tenant.id, bookingId);
    const pendingTypes = new Set(booking.changeRequests.map((r) => r.type));
    const alreadyPending = "Sudah ada permintaan yang menunggu keputusan untuk booking ini.";
    return {
      bookingId,
      status: booking.status,
      startDate: isoDay(booking.startDate)!,
      termMonths: booking.termMonths,
      assetId: booking.assetId,
      assetCode: booking.asset?.code ?? null,
      canCancel: !cancelBlocked && !pendingTypes.has("CANCEL"),
      cancelBlockedReason: cancelBlocked ?? (pendingTypes.has("CANCEL") ? alreadyPending : null),
      canChangeStartDate: !dateBlocked && !pendingTypes.has("CHANGE_START_DATE"),
      changeStartDateBlockedReason: dateBlocked ?? (pendingTypes.has("CHANGE_START_DATE") ? alreadyPending : null),
      contractSigned: Boolean(booking.contracts[0]?.signedAt),
      pending: booking.changeRequests,
      cancelIsImmediate: selfApprovesOnRequest(user.roleAssignments, "CANCEL", tenant.id, policy),
    };
  }

  async availableUnits(tenant: ResolvedTenant, bookingId: string, newStartDate: string): Promise<AvailableUnitsForDateDto> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newStartDate)) throw new BadRequestException("newStartDate harus berformat YYYY-MM-DD.");
    return this.bookings.unitsFreeForStartDate(tenant, bookingId, dayToDate(newStartDate));
  }

  async list(user: AuthenticatedUser, tenant: ResolvedTenant, query: ChangeRequestListQuery): Promise<ChangeRequestDto[]> {
    const rows = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.changeRequest.findMany({
        where: {
          ...(query.status === "PENDING" ? { status: "PENDING" } : query.status === "HISTORY" ? { status: { not: "PENDING" } } : {}),
          ...(query.bookingId ? { bookingId: query.bookingId } : {}),
          ...(query.customerId ? { booking: { customerId: query.customerId } } : {}),
        },
        include: REQUEST_INCLUDE,
        orderBy: query.status === "PENDING" ? { requestedAt: "asc" } : { requestedAt: "desc" },
        take: 300,
      }),
    );
    return this.toDtos(user, tenant, rows);
  }

  async get(user: AuthenticatedUser, tenant: ResolvedTenant, id: string): Promise<ChangeRequestDto> {
    const row = await this.prisma.runInTenantContext(tenant.id, (tx) => tx.changeRequest.findUnique({ where: { id }, include: REQUEST_INCLUDE }));
    if (!row) throw new NotFoundException("Permintaan tidak ditemukan.");
    return (await this.toDtos(user, tenant, [row]))[0]!;
  }

  private async toDtos(user: AuthenticatedUser, tenant: ResolvedTenant, rows: RequestRow[]): Promise<ChangeRequestDto[]> {
    if (rows.length === 0) return [];
    const policy = await this.policyFor(tenant);
    const blackoutMonths = resolveBlackoutMonths(tenant.featureFlags);

    // Requesters and deciders may sit in another branch of the organization (a super admin).
    const userIds = [...new Set(rows.flatMap((r) => [r.requestedByUserId, r.decidedByUserId]).filter((x): x is string => Boolean(x)))];
    const users = await withOrgReadContext(this.prisma.raw, tenant.organizationId, (tx) =>
      tx.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true, email: true } }),
    );
    const nameOf = new Map(users.map((u) => [u.id, u.displayName || u.email]));
    const person = (id: string) => ({ id, name: nameOf.get(id) ?? "—" });

    const assetIds = [
      ...new Set(
        rows.flatMap((r) => {
          const p = (r.payload ?? {}) as DateChangePayload;
          return [p.assetId, p.previousAssetId].filter((x): x is string => Boolean(x));
        }),
      ),
    ];
    const { codeOf, unitFree } = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const assets = assetIds.length ? await tx.asset.findMany({ where: { id: { in: assetIds } }, select: { id: true, code: true } }) : [];
      // For a pending date change, is the unit it asks for free right now? The approver sees a conflict before deciding.
      const free = new Map<string, boolean>();
      for (const r of rows) {
        if (r.status !== "PENDING" || r.type !== "CHANGE_START_DATE") continue;
        const p = (r.payload ?? {}) as DateChangePayload;
        const target = p.assetId ?? r.booking.assetId;
        if (!p.newStartDate || !target || !r.booking.termMonths) continue;
        const units = await listAvailableStorageAssets(
          tx,
          r.booking.assetTypeId,
          r.booking.locationId ?? undefined,
          { startDate: dayToDate(p.newStartDate), termMonths: r.booking.termMonths },
          { blackoutMonths, customerId: r.booking.customerId, extendsBookingId: r.booking.extendsBookingId ?? undefined, excludeBookingId: r.booking.id },
        );
        free.set(r.id, units.some((u) => u.id === target));
      }
      return { codeOf: new Map(assets.map((a) => [a.id, a.code])), unitFree: free };
    });

    return rows.map((r) => {
      const p = (r.payload ?? {}) as DateChangePayload;
      const decision =
        r.status === "PENDING"
          ? checkChangeDecision({
              requesterUserId: r.requestedByUserId,
              deciderUserId: user.id,
              deciderRoles: user.roleAssignments,
              type: r.type as ChangeRequestType,
              tenantId: tenant.id,
              policy,
            })
          : null;
      const b = r.booking;
      return {
        id: r.id,
        bookingId: r.bookingId,
        type: r.type,
        status: r.status,
        reason: r.reason,
        payload:
          r.type === "CHANGE_START_DATE"
            ? {
                newStartDate: p.newStartDate,
                previousStartDate: p.previousStartDate,
                assetId: p.assetId ?? null,
                assetCode: p.assetId ? (codeOf.get(p.assetId) ?? null) : null,
                previousAssetId: p.previousAssetId ?? null,
                previousAssetCode: p.previousAssetId ? (codeOf.get(p.previousAssetId) ?? null) : null,
                signedContract: p.signedContract,
              }
            : {},
        requestedBy: person(r.requestedByUserId),
        requestedAt: r.requestedAt.toISOString(),
        decidedBy: r.decidedByUserId ? person(r.decidedByUserId) : null,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        decisionNote: r.decisionNote,
        result: (r.result as Record<string, unknown> | null) ?? null,
        booking: {
          id: b.id,
          status: b.status,
          startDate: isoDay(b.startDate)!,
          endDate: isoDay(b.endDate),
          termMonths: b.termMonths,
          customerId: b.customer.id,
          customerName: b.customer.fullName ?? b.customer.companyName ?? "—",
          customerNumber: b.customer.customerNumber,
          assetCode: b.asset?.code ?? null,
          assetTypeName: b.assetType.name,
          contractNumber: b.contracts[0]?.contractNumber ?? null,
          contractSigned: Boolean(b.contracts[0]?.signedAt),
        },
        unitFree: unitFree.has(r.id) ? unitFree.get(r.id)! : null,
        canDecide: decision?.allowed === true,
        cannotDecideReason: decision && !decision.allowed && decision.denial === "SELF_DECISION" ? ("SELF_DECISION" as const) : null,
        canWithdraw: r.status === "PENDING" && r.requestedByUserId === user.id,
      };
    });
  }

  // ---------------------------------------------------------------- requesting

  /**
   * File a request. Refused at once when the booking could not be changed
   * anyway (wrong status, money has moved) — staff hear it now, not from the
   * approver. A super admin's own CANCEL approves itself here, in one step.
   */
  async create(user: AuthenticatedUser, tenant: ResolvedTenant, body: CreateChangeRequest): Promise<ChangeRequestDto> {
    const policy = await this.policyFor(tenant);
    const booking = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.booking.findUnique({ where: { id: body.bookingId }, include: { contracts: { orderBy: { createdAt: "desc" }, take: 1, select: { signedAt: true } } } }),
    );
    if (!booking) throw new NotFoundException("Booking tidak ditemukan.");

    let payload: DateChangePayload = {};
    if (body.type === "CANCEL") {
      const blocker = await this.bookings.cancellationBlocker(tenant.id, booking.id);
      if (blocker) throw new ConflictException({ code: CANCELLABLE_STATUSES.includes(booking.status) ? "PAYMENT_EXISTS" : "NOT_CANCELLABLE", message: blocker });
    } else {
      const blocker = await this.bookings.startDateChangeBlocker(tenant.id, booking.id);
      if (blocker) throw new ConflictException({ code: START_DATE_CHANGEABLE_STATUSES.includes(booking.status) ? "START_DATE_BLOCKED" : "START_DATE_NOT_CHANGEABLE", message: blocker });
      payload = await this.validDatePayload(tenant, booking, {
        newStartDate: body.newStartDate,
        assetId: body.assetId ?? null,
        signedContract: body.signedContract,
      });
      payload.previousStartDate = isoDay(booking.startDate)!;
      payload.previousAssetId = booking.assetId;
    }

    let created: { id: string };
    try {
      created = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
        const pending = await tx.changeRequest.findFirst({ where: { bookingId: booking.id, type: body.type, status: "PENDING" }, select: { id: true } });
        if (pending) throw new ConflictException({ code: "REQUEST_ALREADY_PENDING", message: "Sudah ada permintaan sejenis yang menunggu keputusan untuk booking ini." });
        return tx.changeRequest.create({
          data: { tenantId: tenant.id, bookingId: booking.id, type: body.type, reason: body.reason, payload: payload as Prisma.InputJsonValue, requestedByUserId: user.id },
          select: { id: true },
        });
      });
    } catch (err) {
      // The partial unique index is the backstop for two requests filed at the same moment.
      if ((err as { code?: string }).code === "P2002") {
        throw new ConflictException({ code: "REQUEST_ALREADY_PENDING", message: "Sudah ada permintaan sejenis yang menunggu keputusan untuk booking ini." });
      }
      throw err;
    }
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId: user.id,
      action: "CHANGE_REQUEST_CREATED",
      entityType: "ChangeRequest",
      entityId: created.id,
      metadata: { bookingId: booking.id, type: body.type, reason: body.reason, payload },
    });

    if (selfApprovesOnRequest(user.roleAssignments, body.type, tenant.id, policy)) {
      try {
        await this.approveAndExecute(user, tenant, created.id, SELF_APPROVED_NOTE, { selfApproved: true });
      } catch (err) {
        // Nothing was cancelled: do not leave a pending request its author can never decide.
        await this.prisma.runInTenantContext(tenant.id, (tx) =>
          tx.changeRequest.updateMany({ where: { id: created.id, status: "PENDING" }, data: { status: "WITHDRAWN", decisionNote: "Pembatalan satu langkah gagal — tidak ada yang berubah." } }),
        );
        throw err;
      }
    }
    return this.get(user, tenant, created.id);
  }

  /** The parts of a date-change request that can be checked without touching anything. */
  private async validDatePayload(
    tenant: ResolvedTenant,
    booking: { id: string; startDate: Date; assetId: string | null; assetTypeId: string; locationId: string | null; contracts: Array<{ signedAt: Date | null }> },
    input: { newStartDate: string; assetId: string | null; signedContract?: SignedContractHandling },
  ): Promise<DateChangePayload> {
    const today = zonedDateString(new Date(), tenant.timezone || "Asia/Jakarta");
    if (input.newStartDate < today) throw new BadRequestException("Tanggal mulai yang baru tidak boleh sebelum hari ini.");
    const unitChanged = Boolean(input.assetId && input.assetId !== booking.assetId);
    if (input.newStartDate === isoDay(booking.startDate) && !unitChanged) {
      throw new BadRequestException("Tanggal mulai yang baru sama dengan yang sekarang.");
    }
    if (unitChanged) {
      const asset = await this.prisma.runInTenantContext(tenant.id, (tx) => tx.asset.findUnique({ where: { id: input.assetId! } }));
      if (!asset) throw new NotFoundException("Unit pengganti tidak ditemukan.");
      if (asset.assetTypeId !== booking.assetTypeId || (booking.locationId && asset.locationId !== booking.locationId)) {
        throw new BadRequestException("Unit pengganti harus bertipe dan bercabang sama dengan booking ini.");
      }
    }
    const signed = Boolean(booking.contracts[0]?.signedAt);
    if (signed && !input.signedContract) {
      throw new BadRequestException({
        code: "SIGNED_CONTRACT_DECISION_REQUIRED",
        message: "Kontrak sudah ditandatangani — pilih: tanda tangan ulang, atau konfirmasi ulang oleh staf.",
      });
    }
    return {
      newStartDate: input.newStartDate,
      assetId: unitChanged ? input.assetId : null,
      ...(signed && input.signedContract ? { signedContract: input.signedContract } : {}),
    };
  }

  /** The requester corrects a pending date change — another date, another unit — typically after the approver hit a conflict. */
  async amend(user: AuthenticatedUser, tenant: ResolvedTenant, id: string, body: AmendChangeRequest): Promise<ChangeRequestDto> {
    const row = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.changeRequest.findUnique({ where: { id }, include: { booking: { include: { contracts: { orderBy: { createdAt: "desc" }, take: 1, select: { signedAt: true } } } } } }),
    );
    if (!row) throw new NotFoundException("Permintaan tidak ditemukan.");
    if (row.requestedByUserId !== user.id) throw new ForbiddenException("Hanya pengaju yang dapat mengubah permintaannya.");
    if (row.status !== "PENDING") throw new ConflictException(`Permintaan sudah ${row.status} — tidak bisa diubah lagi.`);
    if (row.type !== "CHANGE_START_DATE") throw new BadRequestException("Hanya permintaan ubah tanggal yang bisa diubah; tarik permintaan pembatalan dan ajukan lagi.");
    const before = (row.payload ?? {}) as DateChangePayload;
    const next = await this.validDatePayload(tenant, row.booking, {
      newStartDate: body.newStartDate ?? before.newStartDate!,
      assetId: body.assetId === undefined ? (before.assetId ?? null) : body.assetId,
      signedContract: body.signedContract ?? before.signedContract,
    });
    const payload: DateChangePayload = { ...next, previousStartDate: before.previousStartDate, previousAssetId: before.previousAssetId };
    const updated = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.changeRequest.updateMany({ where: { id, status: "PENDING" }, data: { payload: payload as Prisma.InputJsonValue, ...(body.reason ? { reason: body.reason } : {}) } }),
    );
    if (updated.count === 0) throw new ConflictException("Permintaan baru saja diputuskan — muat ulang.");
    await this.audit.record({ tenantId: tenant.id, actorUserId: user.id, action: "CHANGE_REQUEST_AMENDED", entityType: "ChangeRequest", entityId: id, metadata: { from: before, to: payload } });
    return this.get(user, tenant, id);
  }

  async withdraw(user: AuthenticatedUser, tenant: ResolvedTenant, id: string): Promise<ChangeRequestDto> {
    const row = await this.prisma.runInTenantContext(tenant.id, (tx) => tx.changeRequest.findUnique({ where: { id } }));
    if (!row) throw new NotFoundException("Permintaan tidak ditemukan.");
    if (row.requestedByUserId !== user.id) throw new ForbiddenException("Hanya pengaju yang dapat menarik permintaannya.");
    const updated = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.changeRequest.updateMany({ where: { id, status: "PENDING" }, data: { status: "WITHDRAWN", decidedAt: new Date() } }),
    );
    if (updated.count === 0) throw new ConflictException(`Permintaan sudah ${row.status} — tidak bisa ditarik.`);
    await this.audit.record({ tenantId: tenant.id, actorUserId: user.id, action: "CHANGE_REQUEST_WITHDRAWN", entityType: "ChangeRequest", entityId: id, metadata: { bookingId: row.bookingId, type: row.type } });
    return this.get(user, tenant, id);
  }

  // ------------------------------------------------------------------ deciding

  async decide(user: AuthenticatedUser, tenant: ResolvedTenant, id: string, body: DecideChangeRequest): Promise<ChangeRequestDto> {
    const policy = await this.policyFor(tenant);
    const row = await this.prisma.runInTenantContext(tenant.id, (tx) => tx.changeRequest.findUnique({ where: { id } }));
    if (!row) throw new NotFoundException("Permintaan tidak ditemukan.");
    if (row.status !== "PENDING") throw new ConflictException({ code: "REQUEST_NOT_PENDING", message: `Permintaan sudah ${row.status}.` });

    const check = checkChangeDecision({
      requesterUserId: row.requestedByUserId,
      deciderUserId: user.id,
      deciderRoles: user.roleAssignments,
      type: row.type as ChangeRequestType,
      tenantId: tenant.id,
      policy,
    });
    if (!check.allowed) {
      const message =
        check.denial === "SELF_DECISION"
          ? "Anda tidak dapat memutuskan permintaan Anda sendiri — harus orang lain yang menyetujui."
          : row.type === "CANCEL"
            ? "Anda tidak berwenang menyetujui pembatalan booking ini."
            : "Anda tidak berwenang menyetujui perubahan tanggal booking ini.";
      // Audited: a refused decision is exactly what the trail is for.
      await this.audit.record({ tenantId: tenant.id, actorUserId: user.id, action: "CHANGE_REQUEST_DECISION_DENIED", entityType: "ChangeRequest", entityId: id, metadata: { denial: check.denial, decision: body.decision } });
      throw new ForbiddenException({ code: check.denial, message });
    }

    if (body.decision === "REJECT") {
      const updated = await this.prisma.runInTenantContext(tenant.id, (tx) =>
        tx.changeRequest.updateMany({ where: { id, status: "PENDING" }, data: { status: "REJECTED", decidedByUserId: user.id, decidedAt: new Date(), decisionNote: body.note ?? null } }),
      );
      if (updated.count === 0) throw new ConflictException({ code: "REQUEST_NOT_PENDING", message: "Permintaan baru saja diputuskan orang lain." });
      await this.audit.record({ tenantId: tenant.id, actorUserId: user.id, action: "CHANGE_REQUEST_REJECTED", entityType: "ChangeRequest", entityId: id, metadata: { bookingId: row.bookingId, type: row.type, note: body.note ?? null } });
      return this.get(user, tenant, id);
    }

    await this.approveAndExecute(user, tenant, id, body.note ?? null, { selfApproved: false });
    return this.get(user, tenant, id);
  }

  /**
   * Claim the request (PENDING -> APPROVED, atomically, so two approvers cannot
   * both run it), do what it asks, record the result. If the change itself is
   * refused — the unit is no longer free, money has moved — the claim is undone
   * and the request is PENDING again with nothing changed.
   */
  private async approveAndExecute(user: AuthenticatedUser, tenant: ResolvedTenant, id: string, note: string | null, opts: { selfApproved: boolean }) {
    const claimed = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.changeRequest.updateMany({ where: { id, status: "PENDING" }, data: { status: "APPROVED", decidedByUserId: user.id, decidedAt: new Date(), decisionNote: note } }),
    );
    if (claimed.count === 0) throw new ConflictException({ code: "REQUEST_NOT_PENDING", message: "Permintaan baru saja diputuskan orang lain." });
    const row = await this.prisma.runInTenantContext(tenant.id, (tx) => tx.changeRequest.findUniqueOrThrow({ where: { id } }));

    let result: Record<string, unknown>;
    try {
      if (row.type === "CANCEL") {
        const booking = await this.bookings.cancelBooking(tenant, row.bookingId, user.id, row.reason, id);
        result = { bookingStatus: booking.status };
      } else {
        const p = (row.payload ?? {}) as DateChangePayload;
        if (!p.newStartDate) throw new BadRequestException("Permintaan ini tidak memuat tanggal baru.");
        result = (await this.bookings.changeStartDate(tenant, row.bookingId, user.id, {
          newStartDate: dayToDate(p.newStartDate),
          assetId: p.assetId ?? null,
          signedContract: p.signedContract,
          reason: row.reason,
          changeRequestId: id,
        })) as unknown as Record<string, unknown>;
      }
    } catch (err) {
      await this.prisma.runInTenantContext(tenant.id, (tx) =>
        tx.changeRequest.updateMany({ where: { id, status: "APPROVED" }, data: { status: "PENDING", decidedByUserId: null, decidedAt: null, decisionNote: null } }),
      );
      const response = err instanceof HttpException ? err.getResponse() : null;
      await this.audit.record({
        tenantId: tenant.id,
        actorUserId: user.id,
        action: "CHANGE_REQUEST_APPROVAL_FAILED",
        entityType: "ChangeRequest",
        entityId: id,
        metadata: { bookingId: row.bookingId, type: row.type, error: response ?? (err instanceof Error ? err.message : String(err)) },
      });
      throw err;
    }

    await this.prisma.runInTenantContext(tenant.id, (tx) => tx.changeRequest.update({ where: { id }, data: { result: result as Prisma.InputJsonValue } }));
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId: user.id,
      action: "CHANGE_REQUEST_APPROVED",
      entityType: "ChangeRequest",
      entityId: id,
      metadata: {
        bookingId: row.bookingId,
        type: row.type,
        requestedByUserId: row.requestedByUserId,
        note,
        // The one documented exception to "the decider is never the requester".
        ...(opts.selfApproved ? { selfApproved: true, basis: "Super Admin one-step cancellation (PRD go-live 2 §4.1)" } : {}),
        result,
      },
    });
  }
}
