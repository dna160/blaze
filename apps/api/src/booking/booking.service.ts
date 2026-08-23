import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { assetFsm, termEndDate } from "@rentos/domain";
import {
  computePooledAvailableCount,
  findAvailableNonPooledAsset,
  findAvailablePooledAsset,
  findAvailableStorageAsset,
  generateTermPaymentSchedule,
  recordDepositHeldEntries,
  resolveBlackoutMonths,
  resolveInvoiceLeadDays,
  voidScheduledInvoices,
  type Prisma,
} from "@rentos/database";
import type { CreateBookingResponse, PipelineBookingDto } from "@rentos/contracts";

import { AuditService } from "../audit/audit.service.js";
import { CrmService } from "../crm/crm.service.js";
import { DocumentsService } from "../documents/documents.service.js";
import { FinanceService } from "../finance/finance.service.js";
import { NotificationsService, type NotifiableCustomer } from "../notifications/notifications.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";
import { WebhookDispatcherService } from "../webhook-dispatch/webhook-dispatch.service.js";

import { bookingFsmFor, GuardFailedError, type BookingActivationContext, type BookingStatus } from "./booking-fsm.util.js";
import { pipelineStageFor } from "./booking-pipeline.util.js";

type RateTierValue = "DAILY" | "WEEKLY" | "MONTHLY";

type TxBooking = {
  id: string;
  assetId: string | null;
  priceSnapshot: unknown;
  startDate: Date;
  rateTier: RateTierValue;
};

const DEFAULT_RESERVATION_TTL_HOURS = 48;

/** Booking models whose invoice math needs both ends of the window (nights/days x rate) — see BookingWindow.endDate. */
const BOOKING_MODELS_REQUIRING_END_DATE = new Set(["NIGHTLY", "DURATION_ORDER"]);

/** Pipeline columns the workbench shows (PRD v2 §5.1) — everything before activation. */
const PIPELINE_STATUSES = ["WAITLISTED", "PENDING_APPROVAL", "NEEDS_INFO", "APPROVED"] as const;

export interface CreateBookingInput {
  assetTypeId: string;
  startDate: Date;
  /** Checkout/return date — required for NIGHTLY, DURATION_ORDER. Ignored otherwise. */
  endDate?: Date;
  /** RECURRING_LEASE only — MONTHLY is the only tier new bookings accept since PRD v2 D1. */
  rateTier?: RateTierValue;
  /** PRD v2 §4 — storage flow: branch + term. Required for RECURRING_LEASE. */
  locationId?: string;
  termMonths?: number;
  extendsBookingId?: string;
  customerPhone: string;
  customerFullName: string;
  /** Set when the storefront sent a customer session (OTP or Google) — the booking is attached to that customer. */
  authenticatedCustomerId?: string;
}

function formatDateId(d: Date): string {
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
}

@Injectable()
export class BookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crm: CrmService,
    private readonly finance: FinanceService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly webhooks: WebhookDispatcherService,
    private readonly documents: DocumentsService,
  ) {}

  /**
   * PRD §7.1.2 booking flow steps 1-5: pick AssetType, soft-reserve a unit,
   * submit for approval. Since PRD v2 §4, RECURRING_LEASE (storage) goes
   * through the branch + size + term flow with date-range availability and
   * a waitlist; NIGHTLY/DURATION_ORDER keep their pre-v2 path unchanged.
   */
  async createBooking(tenant: ResolvedTenant, input: CreateBookingInput): Promise<CreateBookingResponse> {
    const customer = input.authenticatedCustomerId
      ? await this.crm.fillProfile(tenant.id, input.authenticatedCustomerId, { phone: input.customerPhone, fullName: input.customerFullName })
      : await this.crm.getOrCreateByPhone(tenant.id, input.customerPhone, input.customerFullName);

    const assetTypeProbe = await this.prisma.runInTenantContext(tenant.id, (tx) => tx.assetType.findUnique({ where: { id: input.assetTypeId } }));
    if (!assetTypeProbe || !assetTypeProbe.isPublished) throw new NotFoundException("AssetType not found.");

    if (assetTypeProbe.bookingModel === "RECURRING_LEASE") {
      return this.createStorageBooking(tenant, customer, input);
    }
    return this.createDatedBooking(tenant, customer, input);
  }

  /** PRD v2 §4.3/§4.4 — the storage path: term + branch, blackout-aware availability, waitlist instead of a dead end. */
  private async createStorageBooking(
    tenant: ResolvedTenant,
    customer: NotifiableCustomer & { isBlocklisted: boolean; kycStatus: string },
    input: CreateBookingInput,
  ): Promise<CreateBookingResponse> {
    if (input.rateTier && input.rateTier !== "MONTHLY") {
      throw new BadRequestException("Daily and weekly rentals are no longer offered — choose a 1, 3, 6, or 12 month term.");
    }
    if (!input.termMonths || !input.locationId) {
      throw new BadRequestException("A branch and a rental term (1, 3, 6, or 12 months) are required.");
    }
    const termMonths = input.termMonths;
    const locationId = input.locationId;
    const endDate = termEndDate(input.startDate, termMonths);
    const blackoutMonths = resolveBlackoutMonths(tenant.featureFlags);

    const { booking, assetCode, waitlistPosition } = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const assetType = await tx.assetType.findUniqueOrThrow({ where: { id: input.assetTypeId } });
      const location = await tx.location.findUnique({ where: { id: locationId } });
      if (!location) throw new NotFoundException("Location not found.");

      let preferredAssetId: string | undefined;
      if (input.extendsBookingId) {
        const parent = await tx.booking.findUnique({ where: { id: input.extendsBookingId } });
        if (!parent || parent.customerId !== customer.id) throw new BadRequestException("The booking being extended was not found.");
        preferredAssetId = parent.assetId ?? undefined;
      }

      const assetId = await findAvailableStorageAsset(
        tx,
        assetType.id,
        locationId,
        { startDate: input.startDate, termMonths },
        { blackoutMonths, customerId: customer.id, extendsBookingId: input.extendsBookingId, preferredAssetId },
      );

      const fsm = bookingFsmFor("RECURRING_LEASE");
      const base = {
        tenantId: tenant.id,
        customerId: customer.id,
        assetTypeId: assetType.id,
        locationId,
        bookingModel: "RECURRING_LEASE" as const,
        rateTier: "MONTHLY" as const,
        startDate: input.startDate,
        endDate,
        termMonths,
        extendsBookingId: input.extendsBookingId,
        priceSnapshot: assetType.pricing as Prisma.InputJsonValue,
      };

      if (!assetId) {
        // Full is never a dead end (PRD v2 P3): park on the waitlist, hold nothing.
        //
        // Two rows, deliberately. The Booking is the customer-facing record —
        // same customer, same price snapshot, same WhatsApp thread, same
        // workbench card as any other request (P3's actual point). The
        // WaitlistEntry is the queue: it owns the position under a unique
        // (tenant, assetType, position) constraint, the ARMED/FIRED/EXPIRED
        // lifecycle and the payment TTL that stop one non-payer freezing a unit
        // (BUILD-SPEC C5 rules 1 and 3). Counting bookings, as this used to,
        // gives a position that silently renumbers whenever an earlier booking
        // changes status.
        const { to } = await fsm.fire("DRAFT", "WAITLIST", {} as BookingActivationContext);
        const created = await tx.booking.create({ data: { ...base, status: to, waitlistedAt: new Date() } });
        await tx.bookingEvent.create({
          data: { tenantId: tenant.id, bookingId: created.id, toStatus: to, actorType: "CUSTOMER", actorId: customer.id, reason: "No capacity for the requested dates — waitlisted" },
        });
        const lastArmed = await tx.waitlistEntry.findFirst({
          where: { assetTypeId: assetType.id },
          orderBy: { position: "desc" },
          select: { position: true },
        });
        const position = (lastArmed?.position ?? 0) + 1;
        await tx.waitlistEntry.create({
          data: {
            tenantId: tenant.id,
            assetTypeId: assetType.id,
            customerId: customer.id,
            bookingId: created.id,
            locationId,
            requestedStartDate: input.startDate,
            termMonths,
            position,
            status: "ARMED",
            kycVerified: customer.kycStatus === "VERIFIED",
            priceSnapshot: assetType.pricing as Prisma.InputJsonValue,
          },
        });
        return { booking: created, assetCode: null as string | null, waitlistPosition: position };
      }

      const { to } = await fsm.fire("DRAFT", "SUBMIT", {} as BookingActivationContext);
      const reservedUntil = new Date(Date.now() + DEFAULT_RESERVATION_TTL_HOURS * 60 * 60 * 1000);
      const created = await tx.booking.create({ data: { ...base, status: to, assetId, reservedUntil } });
      await this.softReserveAsset(tx, assetId);
      await tx.bookingEvent.create({
        data: { tenantId: tenant.id, bookingId: created.id, toStatus: to, actorType: "CUSTOMER", actorId: customer.id, reason: "Booking submitted via storefront" },
      });
      const asset = await tx.asset.findUniqueOrThrow({ where: { id: assetId } });
      return { booking: created, assetCode: asset.code as string | null, waitlistPosition: null as number | null };
    });

    const context = await this.bookingContext(tenant.id, booking.id);
    await this.notifications.notifyCustomer({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      customer,
      templateKey: waitlistPosition ? "booking_waitlisted" : "booking_received",
      variables: {
        customerName: customer.fullName ?? "Customer",
        bookingId: booking.id,
        assetTypeName: context.assetTypeName,
        locationName: context.locationName ?? "",
        startDate: formatDateId(booking.startDate),
        termMonths: String(termMonths),
        position: waitlistPosition ? String(waitlistPosition) : "",
      },
      link: { purpose: "BOOKING", next: `/portal/bookings/${booking.id}` },
    });

    return { id: booking.id, status: booking.status, waitlistPosition, assetCode };
  }

  /** Pre-v2 path for NIGHTLY / DURATION_ORDER — unchanged behavior. */
  private async createDatedBooking(
    tenant: ResolvedTenant,
    customer: NotifiableCustomer & { isBlocklisted: boolean; kycStatus: string },
    input: CreateBookingInput,
  ): Promise<CreateBookingResponse> {
    const booking = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const assetType = await tx.assetType.findUniqueOrThrow({ where: { id: input.assetTypeId } });
      const requiresEndDate = BOOKING_MODELS_REQUIRING_END_DATE.has(assetType.bookingModel);

      if (requiresEndDate) {
        if (!input.endDate) {
          throw new BadRequestException("An end date is required for this booking.");
        }
        if (input.endDate.getTime() <= input.startDate.getTime()) {
          throw new BadRequestException("End date must be after the start date.");
        }
      }

      // Pooled AssetTypes (isPooled: true, e.g. shared dorm beds) don't
      // hold one specific Asset per booking — capacity is checked as a
      // count over the requested date window instead, and a concrete
      // unit only gets assigned at approval time (see approve()). See
      // docs/HANDOFF.md Session 17.
      let availableAssetId: string | null = null;
      if (assetType.isPooled) {
        const capacity = await computePooledAvailableCount(tx, assetType, input.startDate, input.endDate!);
        if (capacity < 1) {
          throw new ConflictException("No units of this type are currently available for the requested dates.");
        }
      } else {
        const isNightly = assetType.bookingModel === "NIGHTLY";
        const otaWindowStart = isNightly ? input.startDate : null;
        const otaWindowEnd = isNightly ? (input.endDate ?? null) : null;
        const foundAssetId = await findAvailableNonPooledAsset(tx, assetType.id, otaWindowStart, otaWindowEnd);
        if (!foundAssetId) {
          throw new ConflictException("No units of this type are currently available.");
        }
        availableAssetId = foundAssetId;
      }

      const fsm = bookingFsmFor(assetType.bookingModel);
      const reservedUntil = new Date(Date.now() + DEFAULT_RESERVATION_TTL_HOURS * 60 * 60 * 1000);

      const created = await tx.booking.create({
        data: {
          tenantId: tenant.id,
          customerId: customer.id,
          assetTypeId: assetType.id,
          assetId: availableAssetId,
          bookingModel: assetType.bookingModel,
          rateTier: "MONTHLY",
          status: "DRAFT",
          startDate: input.startDate,
          endDate: requiresEndDate ? input.endDate : undefined,
          priceSnapshot: assetType.pricing as Prisma.InputJsonValue,
          reservedUntil,
        },
      });

      const { to } = await fsm.fire("DRAFT", "SUBMIT", {} as BookingActivationContext);
      if (availableAssetId) {
        await assetFsm.fire("AVAILABLE", "RESERVE", undefined);
        await tx.asset.update({ where: { id: availableAssetId }, data: { status: "RESERVED" } });
      }

      const updated = await tx.booking.update({ where: { id: created.id }, data: { status: to }, include: { asset: true } });
      await tx.bookingEvent.create({
        data: {
          tenantId: tenant.id,
          bookingId: created.id,
          toStatus: to,
          actorType: "CUSTOMER",
          actorId: customer.id,
          reason: "Booking submitted via storefront",
        },
      });
      return updated;
    });

    await this.notifications.notifyCustomer({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      customer,
      templateKey: "booking_received",
      variables: { customerName: customer.fullName ?? "Customer", bookingId: booking.id, startDate: formatDateId(booking.startDate) },
      link: { purpose: "BOOKING", next: `/portal/bookings/${booking.id}` },
    });

    return { id: booking.id, status: booking.status, waitlistPosition: null, assetCode: booking.asset?.code ?? null };
  }

  /** The physical floor state (PRD v2 P8): reserve only a unit that's actually free today — a future booking on an occupied unit leaves it OCCUPIED. */
  private async softReserveAsset(tx: Prisma.TransactionClient, assetId: string) {
    const asset = await tx.asset.findUniqueOrThrow({ where: { id: assetId } });
    if (asset.status === "AVAILABLE") {
      await assetFsm.fire("AVAILABLE", "RESERVE", undefined);
      await tx.asset.update({ where: { id: assetId }, data: { status: "RESERVED" } });
    }
  }

  /** Release a unit held by a booking that's leaving the pipeline — only if no other committed booking still holds it physically. */
  private async releaseAsset(tx: Prisma.TransactionClient, assetId: string, exceptBookingId: string) {
    const stillHeld = await tx.booking.count({
      where: { assetId, id: { not: exceptBookingId }, status: { in: ["ACTIVE", "RENEWING", "SUSPENDED", "NOTICE_GIVEN", "DEFAULT", "PAID", "CHECKED_IN", "PICKED_UP"] } },
    });
    if (stillHeld > 0) return;
    const asset = await tx.asset.findUniqueOrThrow({ where: { id: assetId } });
    if (asset.status === "RESERVED" || asset.status === "OCCUPIED") {
      await tx.asset.update({ where: { id: assetId }, data: { status: "AVAILABLE" } });
    }
  }

  private async bookingContext(tenantId: string, bookingId: string) {
    const b = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.booking.findUniqueOrThrow({
        where: { id: bookingId },
        include: { assetType: { select: { name: true } }, asset: { select: { code: true } }, location: { select: { name: true, address: true } } },
      }),
    );
    return { assetTypeName: b.assetType.name, assetCode: b.asset?.code ?? null, locationName: b.location?.name ?? null, locationAddress: b.location?.address ?? null };
  }

  async listPendingApproval(tenantId: string) {
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.booking.findMany({
        where: { status: "PENDING_APPROVAL" },
        include: { customer: true, assetType: true, asset: true },
        orderBy: { createdAt: "asc" },
      }),
    );
  }

  /**
   * PRD v2 §5.1 — every booking still in the pipeline, with its derived
   * stage and the context each column's card needs (customer, unit,
   * branch, first invoice, contract). Waitlist position is read off the
   * WaitlistEntry queue rather than recomputed by counting cards, so the
   * number a customer was told in their message is the number staff see.
   */
  async listPipeline(tenant: ResolvedTenant): Promise<PipelineBookingDto[]> {
    const kycRequired = Boolean(tenant.featureFlags.kyc_required);
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const bookings = await tx.booking.findMany({
        where: { status: { in: [...PIPELINE_STATUSES] } },
        include: {
          customer: { select: { id: true, fullName: true, phone: true, email: true, kycStatus: true, preferredChannel: true, kycDocuments: { where: { status: "PENDING_REVIEW" }, select: { id: true } } } },
          assetType: { select: { id: true, name: true } },
          asset: { select: { id: true, code: true } },
          location: { select: { id: true, name: true } },
          invoices: { orderBy: [{ scheduleIndex: "asc" }, { issueDate: "asc" }], take: 1, select: { id: true, invoiceNumber: true, status: true, totalAmount: true, dueDate: true } },
          contracts: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, signedAt: true, unsignedDocumentUrl: true, documentUrl: true } },
        },
        orderBy: { createdAt: "asc" },
      });

      // One query for the whole board: bookingId -> queue position.
      const waitlistPositions = new Map<string, number>(
        (
          await tx.waitlistEntry.findMany({
            where: { status: "ARMED", bookingId: { not: null } },
            select: { bookingId: true, position: true },
          })
        ).map((e) => [e.bookingId!, e.position]),
      );
      return bookings.map((b) => {
        const firstInvoice = b.invoices[0] ?? null;
        const contract = b.contracts[0] ?? null;
        const { stage, detail } = pipelineStageFor({
          status: b.status,
          kycRequired,
          customerKycStatus: b.customer.kycStatus,
          kycRequestedAt: b.kycRequestedAt,
          firstInvoice: firstInvoice ? { status: firstInvoice.status, dueDate: firstInvoice.dueDate } : null,
          contractGeneratedAt: b.contractGeneratedAt,
          pendingKycDocuments: b.customer.kycDocuments.length,
        });
        const waitlistPosition = b.status === "WAITLISTED" ? (waitlistPositions.get(b.id) ?? null) : null;
        return {
          id: b.id,
          status: b.status,
          bookingModel: b.bookingModel,
          assetTypeId: b.assetTypeId,
          assetId: b.assetId,
          customerId: b.customerId,
          startDate: b.startDate.toISOString(),
          endDate: b.endDate?.toISOString() ?? null,
          anchorDay: b.anchorDay,
          rateTier: b.rateTier,
          reservedUntil: b.reservedUntil?.toISOString() ?? null,
          locationId: b.locationId,
          termMonths: b.termMonths,
          extendsBookingId: b.extendsBookingId,
          kycRequestedAt: b.kycRequestedAt?.toISOString() ?? null,
          contractGeneratedAt: b.contractGeneratedAt?.toISOString() ?? null,
          waitlistedAt: b.waitlistedAt?.toISOString() ?? null,
          createdAt: b.createdAt.toISOString(),
          pipelineStage: stage,
          stageDetail: detail,
          waitlistPosition,
          customer: {
            id: b.customer.id,
            fullName: b.customer.fullName,
            phone: b.customer.phone,
            email: b.customer.email,
            kycStatus: b.customer.kycStatus,
            preferredChannel: b.customer.preferredChannel,
          },
          assetType: b.assetType,
          asset: b.asset,
          location: b.location,
          firstInvoice: firstInvoice
            ? { id: firstInvoice.id, invoiceNumber: firstInvoice.invoiceNumber, status: firstInvoice.status, totalAmount: firstInvoice.totalAmount.toString(), dueDate: firstInvoice.dueDate.toISOString() }
            : null,
          contract: contract ? { id: contract.id, signedAt: contract.signedAt?.toISOString() ?? null, hasDocument: Boolean(contract.unsignedDocumentUrl ?? contract.documentUrl) } : null,
        };
      });
    });
  }

  async getBooking(tenantId: string, bookingId: string) {
    const booking = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.booking.findUnique({
        where: { id: bookingId },
        include: { customer: true, assetType: true, asset: true, location: true, events: { orderBy: { createdAt: "asc" } } },
      }),
    );
    if (!booking) throw new NotFoundException("Booking not found.");
    return booking;
  }

  listForCustomer(tenantId: string, customerId: string) {
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.booking.findMany({
        where: { customerId },
        include: { assetType: true, asset: true, location: true },
        orderBy: { createdAt: "desc" },
      }),
    );
  }

  /**
   * Approval workbench: approve (PRD §7.2.1).
   *
   * Term leases (PRD v2 §5.1) only move to APPROVED here — the invoice and
   * contract come later, at "Generate contract + proforma", after KYC. The
   * customer is told the next step (verify identity) with a magic link.
   *
   * NIGHTLY / DURATION_ORDER / legacy leases keep the pre-v2 behavior:
   * approval generates the first invoice + contract and sends the payment
   * link in one message (automation A3).
   */
  async approve(tenant: ResolvedTenant, bookingId: string, approverUserId: string, assetId?: string) {
    const probe = await this.prisma.runInTenantContext(tenant.id, (tx) => tx.booking.findUnique({ where: { id: bookingId } }));
    if (!probe) throw new NotFoundException("Booking not found.");
    if (probe.bookingModel === "RECURRING_LEASE" && probe.termMonths) {
      return this.approveTermLease(tenant, bookingId, approverUserId);
    }

    const { booking, invoice } = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const existing = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });

      const fsm = bookingFsmFor(existing.bookingModel);
      const { to } = await fsm.fire(existing.status as never, "APPROVE", {} as BookingActivationContext);

      let finalAssetId = assetId ?? existing.assetId;
      if (!finalAssetId) {
        // Pooled bookings never reserve a specific unit at submission
        // (see createBooking) — this is the first point a concrete
        // Asset gets attached. Auto-pick from the pool unless staff
        // passed an explicit assetId above.
        const assetType = await tx.assetType.findUnique({ where: { id: existing.assetTypeId } });
        if (assetType?.isPooled && existing.endDate) {
          const pooledAssetId = await findAvailablePooledAsset(tx, assetType, existing.startDate, existing.endDate);
          if (!pooledAssetId) {
            throw new ConflictException("No units of this type are available for the requested dates.");
          }
          finalAssetId = pooledAssetId;
          await assetFsm.fire("AVAILABLE", "RESERVE", undefined);
          await tx.asset.update({ where: { id: finalAssetId }, data: { status: "RESERVED" } });
        } else {
          throw new BadRequestException("An asset must be assigned before a booking can be approved.");
        }
      }

      const updated = await tx.booking.update({
        where: { id: bookingId },
        data: { status: to, assetId: finalAssetId, approvedByUserId: approverUserId },
      });

      const inv = await this.finance.generateInitialInvoice(tx, tenant.id, tenant.slug, tenant.isPkp, {
        id: updated.id,
        bookingModel: updated.bookingModel,
        customerId: updated.customerId,
        startDate: updated.startDate,
        endDate: updated.endDate,
        anchorDay: updated.anchorDay,
        rateTier: updated.rateTier,
        priceSnapshot: updated.priceSnapshot,
      });

      // Contract is always generated on approval (PRD §5.3) — whether signing it is a hard
      // gate before ACTIVATE depends on the tenant's contract_required feature flag, checked
      // at activation time, not here. Wet-sign PDF upload is v1 scope (PRD §11 ESignProvider).
      await tx.contract.create({
        data: { tenantId: tenant.id, bookingId, templateVersion: "v1" },
      });

      await tx.bookingEvent.create({
        data: {
          tenantId: tenant.id,
          bookingId,
          fromStatus: existing.status,
          toStatus: to,
          actorType: "USER",
          actorId: approverUserId,
          reason: "Approved via console workbench",
        },
      });

      return { booking: updated, invoice: inv };
    });

    const customer = await this.crm.getById(tenant.id, booking.customerId);
    await this.notifications.notifyCustomer({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      customer,
      templateKey: "booking_approved_payment_link",
      variables: { invoiceNumber: invoice.invoiceNumber, totalAmount: invoice.totalAmount.toString() },
      link: { purpose: "INVOICE", next: `/portal/invoices/${invoice.id}` },
    });
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId: approverUserId,
      action: "BOOKING_APPROVED",
      entityType: "Booking",
      entityId: bookingId,
    });
    await this.webhooks.dispatch(tenant, "booking.approved", {
      bookingId: booking.id,
      bookingModel: booking.bookingModel,
      assetId: booking.assetId,
      customerId: booking.customerId,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      totalAmount: invoice.totalAmount.toString(),
    });

    return { booking, invoice };
  }

  /** PRD v2 §5.1 stage 1 for term leases: APPROVE only; next step is KYC (or contract, if the tenant doesn't require KYC / it's already verified). */
  private async approveTermLease(tenant: ResolvedTenant, bookingId: string, approverUserId: string) {
    const booking = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const existing = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
      if (!existing.assetId) throw new BadRequestException("An asset must be assigned before a booking can be approved — offer the customer a unit first.");
      const fsm = bookingFsmFor(existing.bookingModel);
      const { to } = await fsm.fire(existing.status as never, "APPROVE", {} as BookingActivationContext);
      const updated = await tx.booking.update({ where: { id: bookingId }, data: { status: to, approvedByUserId: approverUserId, reservedUntil: null } });
      await tx.bookingEvent.create({
        data: { tenantId: tenant.id, bookingId, fromStatus: existing.status, toStatus: to, actorType: "USER", actorId: approverUserId, reason: "Approved via console workbench" },
      });
      return updated;
    });

    const customer = await this.crm.getById(tenant.id, booking.customerId);
    const kycRequired = Boolean(tenant.featureFlags.kyc_required) && customer.kycStatus !== "VERIFIED";
    await this.notifications.notifyCustomer({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      customer,
      templateKey: "booking_approved",
      variables: { customerName: customer.fullName ?? "Customer", bookingId: booking.id },
      link: { purpose: kycRequired ? "KYC" : "BOOKING", next: kycRequired ? "/portal/kyc" : `/portal/bookings/${booking.id}` },
    });
    await this.audit.record({ tenantId: tenant.id, actorUserId: approverUserId, action: "BOOKING_APPROVED", entityType: "Booking", entityId: bookingId });
    return { booking, invoice: null };
  }

  /** PRD v2 §5.1 stage 2: send (or re-send) the KYC request with a magic link straight into the upload page. */
  async requestKyc(tenant: ResolvedTenant, bookingId: string, actorUserId: string) {
    const booking = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const existing = await tx.booking.findUnique({ where: { id: bookingId }, include: { customer: true } });
      if (!existing) throw new NotFoundException("Booking not found.");
      if (existing.status !== "APPROVED") throw new ConflictException(`Booking is ${existing.status} — KYC is requested after approval.`);
      if (existing.customer.kycStatus === "VERIFIED") throw new ConflictException("This customer is already KYC-verified — generate the contract instead.");
      await tx.bookingEvent.create({
        data: { tenantId: tenant.id, bookingId, fromStatus: existing.status, toStatus: existing.status, actorType: "USER", actorId: actorUserId, reason: existing.kycRequestedAt ? "KYC request re-sent" : "KYC requested" },
      });
      return tx.booking.update({ where: { id: bookingId }, data: { kycRequestedAt: new Date() }, include: { customer: true } });
    });

    await this.notifications.notifyCustomer({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      customer: booking.customer,
      templateKey: "kyc_requested",
      variables: { customerName: booking.customer.fullName ?? "Customer", bookingId: booking.id },
      link: { purpose: "KYC", next: "/portal/kyc" },
    });
    await this.audit.record({ tenantId: tenant.id, actorUserId, action: "KYC_REQUESTED", entityType: "Booking", entityId: bookingId });
    return booking;
  }

  /**
   * PRD v2 §5.1 stage 3: generate the rental agreement + the whole payment
   * schedule (proforma issued now, later cycles SCHEDULED), render both
   * PDFs, and send the customer a pay-now link. Requires KYC to be
   * satisfied (or not required by the tenant) and a unit assigned.
   */
  async generateContractAndProforma(tenant: ResolvedTenant, bookingId: string, actorUserId: string) {
    const blackoutMonths = resolveBlackoutMonths(tenant.featureFlags);
    const leadDays = resolveInvoiceLeadDays(tenant.featureFlags);
    const kycRequired = Boolean(tenant.featureFlags.kyc_required);

    const result = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
        include: { customer: true, assetType: true, asset: true, location: true, invoices: { select: { id: true } } },
      });
      if (!booking) throw new NotFoundException("Booking not found.");
      if (booking.status !== "APPROVED") throw new ConflictException(`Booking is ${booking.status} — the contract is generated after approval.`);
      if (!booking.termMonths) throw new BadRequestException("Only term leases use the contract + proforma step.");
      if (!booking.assetId) throw new BadRequestException("Assign a unit before generating the contract.");
      if (kycRequired && booking.customer.kycStatus !== "VERIFIED") {
        throw new ConflictException("KYC is not verified yet — the contract can be generated once the customer's documents are approved.");
      }
      if (booking.invoices.length > 0) throw new ConflictException("This booking already has its payment schedule.");

      const contract =
        (await tx.contract.findFirst({ where: { bookingId }, orderBy: { createdAt: "desc" } })) ??
        (await tx.contract.create({ data: { tenantId: tenant.id, bookingId, templateVersion: "v2-term" } }));

      const { proforma, cycles } = await generateTermPaymentSchedule(
        tx,
        tenant.id,
        tenant.slug,
        tenant.isPkp,
        {
          id: booking.id,
          bookingModel: booking.bookingModel,
          customerId: booking.customerId,
          startDate: booking.startDate,
          endDate: booking.endDate,
          anchorDay: booking.anchorDay,
          rateTier: booking.rateTier,
          termMonths: booking.termMonths,
          priceSnapshot: booking.priceSnapshot,
        },
        { leadDays },
      );

      await tx.booking.update({ where: { id: bookingId }, data: { contractGeneratedAt: new Date() } });
      await tx.bookingEvent.create({
        data: { tenantId: tenant.id, bookingId, fromStatus: booking.status, toStatus: booking.status, actorType: "USER", actorId: actorUserId, reason: `Contract + proforma ${proforma.invoiceNumber} generated (${1 + cycles.length} payments)` },
      });
      return { booking, contract, proforma, cycles };
    });

    // PDFs are rendered outside the DB transaction (I/O to storage), then the keys are attached.
    const pricing = result.booking.priceSnapshot as { basePrice?: number; adminFee?: number; currency?: string };
    const schedule = [result.proforma, ...result.cycles].map((inv) => ({
      index: inv.scheduleIndex ?? 0,
      periodStart: inv.periodStart!,
      periodEnd: inv.periodEnd!,
      dueDate: inv.dueDate,
      totalAmount: inv.totalAmount.toString(),
    }));
    const depositLine = result.proforma.lines.find((l) => l.lineType === "DEPOSIT");
    const tenantRow = await this.prisma.raw.tenant.findUniqueOrThrow({ where: { id: tenant.id }, select: { legalName: true } });
    const contractPdf = await this.documents.renderContract({
      tenant: { name: tenant.name, legalName: tenantRow.legalName, slug: tenant.slug },
      contractId: result.contract.id,
      customer: result.booking.customer,
      unit: { code: result.booking.asset?.code ?? null, assetTypeName: result.booking.assetType.name, locationName: result.booking.location?.name ?? null, locationAddress: result.booking.location?.address ?? null },
      term: {
        startDate: result.booking.startDate,
        endDate: result.booking.endDate,
        termMonths: result.booking.termMonths,
        monthlyRent: String(pricing.basePrice ?? 0),
        deposit: depositLine?.amount.toString() ?? "0",
        adminFee: String(pricing.adminFee ?? 0),
        currency: pricing.currency ?? "IDR",
      },
      schedule,
      blackoutMonths,
      generatedAt: new Date(),
    });
    const contractKey = await this.documents.store(`contracts/${tenant.id}/${bookingId}/agreement-${result.contract.id}.pdf`, contractPdf);
    const proformaPdf = await this.documents.renderInvoice({
      tenant: { name: tenant.name, legalName: tenantRow.legalName, isPkp: tenant.isPkp },
      invoice: { ...result.proforma, subtotal: result.proforma.subtotal.toString(), taxAmount: result.proforma.taxAmount.toString(), totalAmount: result.proforma.totalAmount.toString(), lines: result.proforma.lines.map((l) => ({ description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), amount: l.amount.toString(), lineType: l.lineType })) },
      customer: result.booking.customer,
      unit: { code: result.booking.asset?.code ?? null, assetTypeName: result.booking.assetType.name, locationName: result.booking.location?.name ?? null },
    });
    const proformaKey = await this.documents.store(`invoices/${tenant.id}/${result.proforma.id}/proforma.pdf`, proformaPdf);
    await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      await tx.contract.update({ where: { id: result.contract.id }, data: { unsignedDocumentUrl: contractKey } });
      await tx.invoice.update({ where: { id: result.proforma.id }, data: { documentUrl: proformaKey } });
    });

    await this.notifications.notifyCustomer({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      customer: result.booking.customer,
      templateKey: "contract_proforma_ready",
      variables: {
        customerName: result.booking.customer.fullName ?? "Customer",
        invoiceNumber: result.proforma.invoiceNumber,
        totalAmount: result.proforma.totalAmount.toString(),
        dueDate: formatDateId(result.proforma.dueDate),
        assetCode: result.booking.asset?.code ?? "",
      },
      link: { purpose: "INVOICE", next: `/portal/invoices/${result.proforma.id}` },
    });
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId,
      action: "CONTRACT_PROFORMA_GENERATED",
      entityType: "Booking",
      entityId: bookingId,
      metadata: { contractId: result.contract.id, proformaInvoiceId: result.proforma.id, scheduledInvoices: result.cycles.length },
    });
    // The tenant-facing "booking.approved" webhook (Session 20) carries invoice fields, so for
    // term leases it fires here — the moment the invoice actually exists — not at approval.
    await this.webhooks.dispatch(tenant, "booking.approved", {
      bookingId: result.booking.id,
      bookingModel: result.booking.bookingModel,
      assetId: result.booking.assetId,
      customerId: result.booking.customerId,
      invoiceId: result.proforma.id,
      invoiceNumber: result.proforma.invoiceNumber,
      totalAmount: result.proforma.totalAmount.toString(),
    });

    return { contractId: result.contract.id, proformaInvoiceId: result.proforma.id, scheduledInvoices: result.cycles.length };
  }

  /** PRD v2 §5.1 waitlist column: staff offer a unit once capacity exists — re-checks availability, reserves, re-enters approval. */
  async offerUnit(tenant: ResolvedTenant, bookingId: string, actorUserId: string, assetId?: string) {
    const blackoutMonths = resolveBlackoutMonths(tenant.featureFlags);
    const booking = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const existing = await tx.booking.findUnique({ where: { id: bookingId }, include: { customer: true } });
      if (!existing) throw new NotFoundException("Booking not found.");
      if (existing.status !== "WAITLISTED") throw new ConflictException(`Booking is ${existing.status}, not waitlisted.`);
      if (!existing.termMonths) throw new BadRequestException("Only term leases can be waitlisted.");

      const chosen =
        assetId ??
        (await findAvailableStorageAsset(
          tx,
          existing.assetTypeId,
          existing.locationId ?? undefined,
          { startDate: existing.startDate, termMonths: existing.termMonths },
          { blackoutMonths, customerId: existing.customerId },
        ));
      if (!chosen) throw new ConflictException("Still no unit free for this customer's dates — try a different branch or date, or wait.");
      const asset = await tx.asset.findUnique({ where: { id: chosen } });
      if (!asset || asset.assetTypeId !== existing.assetTypeId) throw new BadRequestException("That unit is not of the requested type.");

      const fsm = bookingFsmFor(existing.bookingModel);
      const { to } = await fsm.fire(existing.status as never, "OFFER_UNIT", {} as BookingActivationContext);
      const reservedUntil = new Date(Date.now() + DEFAULT_RESERVATION_TTL_HOURS * 60 * 60 * 1000);
      const updated = await tx.booking.update({
        where: { id: bookingId },
        data: { status: to, assetId: chosen, reservedUntil },
        include: { customer: true, asset: true, assetType: true, location: true },
      });
      await this.softReserveAsset(tx, chosen);
      // The queue row leaves the queue with the booking. CONVERTED (not
      // CANCELLED) — this entry got what it was waiting for. Remaining ARMED
      // entries keep their positions; they are ordered relative to each other,
      // and resequencing them here would renumber every customer's "#n" on
      // every offer.
      await tx.waitlistEntry.updateMany({
        where: { bookingId, status: "ARMED" },
        data: { status: "CONVERTED", firedAt: new Date() },
      });
      await tx.bookingEvent.create({
        data: { tenantId: tenant.id, bookingId, fromStatus: existing.status, toStatus: to, actorType: "USER", actorId: actorUserId, reason: `Unit ${asset.code} offered from the waitlist` },
      });
      return updated;
    });

    await this.notifications.notifyCustomer({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      customer: booking.customer,
      templateKey: "waitlist_unit_offered",
      variables: { customerName: booking.customer.fullName ?? "Customer", assetTypeName: booking.assetType.name, assetCode: booking.asset?.code ?? "", locationName: booking.location?.name ?? "" },
      link: { purpose: "BOOKING", next: `/portal/bookings/${booking.id}` },
    });
    await this.audit.record({ tenantId: tenant.id, actorUserId, action: "WAITLIST_UNIT_OFFERED", entityType: "Booking", entityId: bookingId, metadata: { assetId: booking.assetId } });
    return booking;
  }

  async reject(tenant: ResolvedTenant, bookingId: string, approverUserId: string, reason: string) {
    const booking = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const existing = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!existing) throw new NotFoundException("Booking not found.");

      const fsm = bookingFsmFor(existing.bookingModel);
      const { to } = await fsm.fire(existing.status as never, "REJECT", {} as BookingActivationContext);

      const updated = await tx.booking.update({
        where: { id: bookingId },
        data: { status: to, rejectionReason: reason },
      });

      if (existing.assetId) {
        await this.releaseAsset(tx, existing.assetId, bookingId);
      }
      await tx.bookingEvent.create({
        data: {
          tenantId: tenant.id,
          bookingId,
          fromStatus: existing.status,
          toStatus: to,
          actorType: "USER",
          actorId: approverUserId,
          reason,
        },
      });
      return updated;
    });

    const customer = await this.crm.getById(tenant.id, booking.customerId);
    await this.notifications.notifyCustomer({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      customer,
      templateKey: "booking_rejected",
      variables: { reason },
    });
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId: approverUserId,
      action: "BOOKING_REJECTED",
      entityType: "Booking",
      entityId: bookingId,
      metadata: { reason },
    });
    return booking;
  }

  /**
   * The APPROVED -> ACTIVE triple-AND guard (PRD §8.1) has two independent
   * async gates that can complete in either order: payment and contract
   * signing. `contractRequired` reads the tenant's `contract_required`
   * feature flag (default off — v1 contract upload has no UI/gate unless a
   * tenant opts in); when it's on, `contractSigned` reflects whether this
   * booking's Contract row (created at approve() time) has a `signedAt`.
   */
  private async computeActivationContext(
    tx: Prisma.TransactionClient,
    tenant: ResolvedTenant,
    booking: TxBooking,
  ): Promise<BookingActivationContext> {
    const featureFlags = (tenant.featureFlags ?? {}) as Record<string, unknown>;
    const contractRequired = Boolean(featureFlags.contract_required);
    let contractSigned = true;
    if (contractRequired) {
      const contract = await tx.contract.findFirst({ where: { bookingId: booking.id }, orderBy: { createdAt: "desc" } });
      contractSigned = Boolean(contract?.signedAt);
    }
    return { contractRequired, contractSigned, firstInvoicePaid: true, unitAssigned: Boolean(booking.assetId) };
  }

  /** Shared tail once an APPROVED -> ACTIVE transition is confirmed legal: move-in, deposit, audit trail. */
  private async finalizeActivation(
    tx: Prisma.TransactionClient,
    tenant: ResolvedTenant,
    booking: TxBooking,
    to: BookingStatus,
    depositLine?: { amount: Prisma.Decimal | string },
  ) {
    // Fixed-term (DAILY/WEEKLY rateTier) bookings never get an anchorDay:
    // that's what excludes them from the recurring-invoice worker job's
    // `anchorDay: { not: null } }` cycle-generation query — they're a
    // one-invoice booking, not an indefinite lease. Only MONTHLY tier
    // (the original indefinite lease, and v2 term leases) gets one.
    let anchorDay: number | null = null;
    if (booking.rateTier === "MONTHLY") {
      const priceSnapshot = booking.priceSnapshot as { prorationRule?: "ANCHOR_DATE" | "FULL_FIRST_PERIOD" };
      anchorDay = priceSnapshot.prorationRule === "FULL_FIRST_PERIOD" ? 1 : booking.startDate.getDate();
    }
    await tx.booking.update({ where: { id: booking.id }, data: { status: to, anchorDay } });

    if (booking.assetId) {
      const asset = await tx.asset.findUniqueOrThrow({ where: { id: booking.assetId } });
      if (asset.status === "RESERVED") await assetFsm.fire("RESERVED", "MOVE_IN", undefined);
      await tx.asset.update({ where: { id: booking.assetId }, data: { status: "OCCUPIED" } });
    }

    if (depositLine) {
      await this.recordDepositIfNeeded(tx, tenant.id, booking.id, depositLine.amount.toString());
    }

    await tx.bookingEvent.create({
      data: { tenantId: tenant.id, bookingId: booking.id, toStatus: to, actorType: "SYSTEM", reason: "Activation gates satisfied" },
    });
  }

  /**
   * Fired when an invoice tied to this booking gets paid (payments module
   * calls this after confirming payment — see PaymentsService). Dispatches
   * to the correct FSM event based on current status: first payment
   * activates the lease (triple-AND guard) — UNLESS the tenant requires a
   * signed contract and it isn't signed yet, in which case this is a
   * legitimate non-error outcome: the invoice is still marked PAID by the
   * caller, the booking just stays APPROVED until
   * tryActivateAfterContractSigned() completes the other gate. A cycle
   * payment un-suspends or completes a renewal (no contract gate there —
   * that's only checked on first activation).
   */
  async handleInvoicePaid(tenant: ResolvedTenant, bookingId: string, invoiceHasDeposit: boolean, depositAmount?: string) {
    await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!booking) throw new NotFoundException("Booking not found.");

      // RECURRING_LEASE has the triple-AND-gated APPROVED -> ACTIVE transition.
      // NIGHTLY/DURATION_ORDER have no such gate — first payment just moves
      // APPROVED -> PAID; a separate staff check-in action moves the unit
      // into service later (see checkIn()).
      const isFirstPaymentActivation = booking.status === "APPROVED";
      let event: "ACTIVATE" | "CYCLE_PAYMENT_RECEIVED" | "PAYMENT_RECEIVED";
      if (isFirstPaymentActivation) {
        event = booking.bookingModel === "RECURRING_LEASE" ? "ACTIVATE" : "PAYMENT_RECEIVED";
      } else if (booking.status === "RENEWING") event = "CYCLE_PAYMENT_RECEIVED";
      else if (booking.status === "SUSPENDED") event = "PAYMENT_RECEIVED";
      else return; // idempotent no-op for statuses that don't expect a payment transition

      const fsm = bookingFsmFor(booking.bookingModel);
      const ctx =
        event === "ACTIVATE"
          ? await this.computeActivationContext(tx, tenant, booking)
          : ({ contractRequired: false, contractSigned: true, firstInvoicePaid: true, unitAssigned: true } as BookingActivationContext);

      let to: BookingStatus;
      try {
        ({ to } = await fsm.fire(booking.status as never, event, ctx));
      } catch (err) {
        if (err instanceof GuardFailedError && event === "ACTIVATE") {
          return; // contract not signed yet — payment is still recorded by the caller; activation resumes once it is
        }
        throw err;
      }

      if (event === "ACTIVATE") {
        await this.finalizeActivation(
          tx,
          tenant,
          booking,
          to,
          invoiceHasDeposit && depositAmount ? { amount: depositAmount } : undefined,
        );
        return;
      }

      await tx.booking.update({ where: { id: bookingId }, data: { status: to } });
      // NIGHTLY/DURATION_ORDER's first payment (APPROVED -> PAID) is the
      // equivalent "money landed" moment RECURRING_LEASE's finalizeActivation
      // handles for ACTIVATE — deposit locks in here, the unit stays RESERVED
      // until check-in.
      if (isFirstPaymentActivation && invoiceHasDeposit && depositAmount) {
        await this.recordDepositIfNeeded(tx, tenant.id, bookingId, depositAmount);
      }
      await tx.bookingEvent.create({
        data: { tenantId: tenant.id, bookingId, fromStatus: booking.status, toStatus: to, actorType: "WEBHOOK", reason: "Payment confirmed" },
      });
    });
  }

  private async recordDepositIfNeeded(tx: Prisma.TransactionClient, tenantId: string, bookingId: string, amount: string) {
    const existingDeposit = await tx.deposit.findFirst({ where: { bookingId } });
    if (existingDeposit) return;
    const deposit = await tx.deposit.create({ data: { tenantId, bookingId, amount, status: "HELD" } });
    await recordDepositHeldEntries(tx, tenantId, deposit.id, amount);
  }

  /**
   * Staff check-in action (PRD Appendix B, NIGHTLY): PAID -> CHECKED_IN,
   * moves the unit into service. DURATION_ORDER has its own equivalent
   * lifecycle methods below (pickUp/returnEquipment/completeInspection) —
   * its FSM shape differs (an extra INSPECTION step), so it isn't reused
   * here.
   */
  async checkIn(tenant: ResolvedTenant, bookingId: string, actorUserId: string) {
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!booking) throw new NotFoundException("Booking not found.");
      if (booking.bookingModel !== "NIGHTLY") {
        throw new BadRequestException(`Check-in is not implemented for ${booking.bookingModel} bookings yet.`);
      }

      const fsm = bookingFsmFor(booking.bookingModel);
      const { to } = await fsm.fire(booking.status as never, "ACTIVATE", {} as BookingActivationContext);

      const updated = await tx.booking.update({ where: { id: bookingId }, data: { status: to } });

      if (booking.assetId) {
        await assetFsm.fire("RESERVED", "MOVE_IN", undefined);
        await tx.asset.update({ where: { id: booking.assetId }, data: { status: "OCCUPIED" } });
      }

      await tx.bookingEvent.create({
        data: { tenantId: tenant.id, bookingId, fromStatus: booking.status, toStatus: to, actorType: "USER", actorId: actorUserId, reason: "Checked in" },
      });

      return updated;
    });
  }

  /**
   * Staff check-out action: CHECKED_IN -> CHECKED_OUT -> CLOSED in one
   * call — NIGHTLY's stay is paid in full upfront (no final settlement
   * invoice), so there's nothing to wait on between the two transitions.
   * Deposit refund, if any, is a separate manual staff action via the
   * existing deposits workflow (DepositsService) — not automated here.
   */
  async checkOut(tenant: ResolvedTenant, bookingId: string, actorUserId: string) {
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!booking) throw new NotFoundException("Booking not found.");
      if (booking.bookingModel !== "NIGHTLY") {
        throw new BadRequestException(`Check-out is not implemented for ${booking.bookingModel} bookings yet.`);
      }

      const fsm = bookingFsmFor(booking.bookingModel);
      const { to: checkedOut } = await fsm.fire(booking.status as never, "SETTLE", {} as BookingActivationContext);
      const { to: closed } = await fsm.fire(checkedOut, "END_DATE_REACHED", {} as BookingActivationContext);

      const updated = await tx.booking.update({ where: { id: bookingId }, data: { status: closed } });

      if (booking.assetId) {
        await assetFsm.fire("OCCUPIED", "MOVE_OUT", undefined);
        await tx.asset.update({ where: { id: booking.assetId }, data: { status: "AVAILABLE" } });
      }

      await tx.bookingEvent.create({
        data: { tenantId: tenant.id, bookingId, fromStatus: booking.status, toStatus: closed, actorType: "USER", actorId: actorUserId, reason: "Checked out" },
      });

      return updated;
    });
  }

  /**
   * Staff pickup action (PRD Appendix B, DURATION_ORDER — equipment
   * rental): PAID -> PICKED_UP, moves the unit into service. Mirrors
   * checkIn() but kept as its own method since the two booking models'
   * FSMs diverge from here.
   */
  async pickUp(tenant: ResolvedTenant, bookingId: string, actorUserId: string) {
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!booking) throw new NotFoundException("Booking not found.");
      if (booking.bookingModel !== "DURATION_ORDER") {
        throw new BadRequestException(`Pickup is not implemented for ${booking.bookingModel} bookings yet.`);
      }

      const fsm = bookingFsmFor(booking.bookingModel);
      const { to } = await fsm.fire(booking.status as never, "ACTIVATE", {} as BookingActivationContext);

      const updated = await tx.booking.update({ where: { id: bookingId }, data: { status: to } });

      if (booking.assetId) {
        await assetFsm.fire("RESERVED", "MOVE_IN", undefined);
        await tx.asset.update({ where: { id: booking.assetId }, data: { status: "OCCUPIED" } });
      }

      await tx.bookingEvent.create({
        data: { tenantId: tenant.id, bookingId, fromStatus: booking.status, toStatus: to, actorType: "USER", actorId: actorUserId, reason: "Picked up" },
      });

      return updated;
    });
  }

  /**
   * Staff return action: PICKED_UP -> RETURNED -> INSPECTION in one call
   * — the equipment physically arrives back and immediately needs
   * inspection before it can be re-listed, so there's nothing real to
   * wait on between those two FSM states (same reasoning as checkOut()
   * collapsing SETTLE + END_DATE_REACHED for NIGHTLY). The unit goes to
   * MAINTENANCE (not straight back to AVAILABLE) so it can't be re-booked
   * while inspection is pending — see completeInspection() for the step
   * that clears it.
   */
  async returnEquipment(tenant: ResolvedTenant, bookingId: string, actorUserId: string) {
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!booking) throw new NotFoundException("Booking not found.");
      if (booking.bookingModel !== "DURATION_ORDER") {
        throw new BadRequestException(`Return is not implemented for ${booking.bookingModel} bookings yet.`);
      }

      const fsm = bookingFsmFor(booking.bookingModel);
      const { to: returned } = await fsm.fire(booking.status as never, "SETTLE", {} as BookingActivationContext);
      const { to: inspection } = await fsm.fire(returned, "CYCLE_INVOICE_ISSUED", {} as BookingActivationContext);

      const updated = await tx.booking.update({ where: { id: bookingId }, data: { status: inspection } });

      if (booking.assetId) {
        await assetFsm.fire("OCCUPIED", "MOVE_OUT", undefined);
        await assetFsm.fire("AVAILABLE", "SET_MAINTENANCE", undefined);
        await tx.asset.update({ where: { id: booking.assetId }, data: { status: "MAINTENANCE" } });
      }

      await tx.bookingEvent.create({
        data: { tenantId: tenant.id, bookingId, fromStatus: booking.status, toStatus: inspection, actorType: "USER", actorId: actorUserId, reason: "Returned — inspection pending" },
      });

      return updated;
    });
  }

  /**
   * Staff inspection-complete action: INSPECTION -> CLOSED, returns the
   * unit to the available pool. Damage deductions against the deposit
   * (if any) are a separate manual action via the existing
   * `DepositsService.applyToDamages` workflow (Session 12) — staff make
   * that call before or after this one, whichever suits their process;
   * it isn't automated here.
   */
  async completeInspection(tenant: ResolvedTenant, bookingId: string, actorUserId: string) {
    return this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!booking) throw new NotFoundException("Booking not found.");
      if (booking.bookingModel !== "DURATION_ORDER") {
        throw new BadRequestException(`Completing inspection is not implemented for ${booking.bookingModel} bookings yet.`);
      }

      const fsm = bookingFsmFor(booking.bookingModel);
      const { to } = await fsm.fire(booking.status as never, "END_DATE_REACHED", {} as BookingActivationContext);

      const updated = await tx.booking.update({ where: { id: bookingId }, data: { status: to } });

      if (booking.assetId) {
        await assetFsm.fire("MAINTENANCE", "RETURN_TO_SERVICE", undefined);
        await tx.asset.update({ where: { id: booking.assetId }, data: { status: "AVAILABLE" } });
      }

      await tx.bookingEvent.create({
        data: { tenantId: tenant.id, bookingId, fromStatus: booking.status, toStatus: to, actorType: "USER", actorId: actorUserId, reason: "Inspection complete" },
      });

      return updated;
    });
  }

  /**
   * Called after a contract is signed (see ContractsService.sign) — the
   * mirror image of handleInvoicePaid's guard: if payment already landed
   * first, this is what actually fires ACTIVATE. A no-op if the booking
   * isn't APPROVED or the invoice still isn't paid — signing alone never
   * activates a lease on its own.
   */
  async tryActivateAfterContractSigned(tenant: ResolvedTenant, bookingId: string) {
    await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!booking || booking.status !== "APPROVED") return;

      const paidInvoice = await tx.invoice.findFirst({
        where: { bookingId, status: "PAID" },
        include: { lines: true },
        orderBy: { createdAt: "asc" },
      });
      if (!paidInvoice) return; // still waiting on payment

      const fsm = bookingFsmFor(booking.bookingModel);
      const ctx = await this.computeActivationContext(tx, tenant, booking);

      let to: BookingStatus;
      try {
        ({ to } = await fsm.fire("APPROVED", "ACTIVATE", ctx));
      } catch (err) {
        if (err instanceof GuardFailedError) return; // still not eligible for some other reason
        throw err;
      }

      const depositLine = paidInvoice.lines.find((l) => l.lineType === "DEPOSIT");
      await this.finalizeActivation(tx, tenant, booking, to, depositLine ? { amount: depositLine.amount } : undefined);
    });
  }

  /**
   * Self-service portal: give notice (PRD §7.1.4).
   *
   * Term leases (PRD v2 P7): the remaining SCHEDULED cycles on/after the
   * effective date are voided — never billed — and no prorated final
   * invoice is generated ("no more proration"); already-issued invoices
   * stand. The worker's term-lifecycle job moves the booking to MOVED_OUT
   * on the effective date. Legacy indefinite leases keep the pre-v2
   * prorated final settlement.
   */
  async giveNotice(tenant: ResolvedTenant, bookingId: string, customerId: string, noticeEffectiveDate: Date) {
    const { booking, finalInvoice, voided } = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const existing = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!existing) throw new NotFoundException("Booking not found.");
      if (existing.customerId !== customerId) throw new BadRequestException("This booking does not belong to you.");
      if (existing.rateTier === "DAILY" || existing.rateTier === "WEEKLY") {
        throw new BadRequestException(
          "This booking has a fixed end date and does not support giving notice. Contact support to modify it.",
        );
      }
      if (existing.termMonths && existing.endDate && noticeEffectiveDate.getTime() >= existing.endDate.getTime()) {
        throw new BadRequestException("Your term already ends on or before that date — no notice is needed.");
      }

      const fsm = bookingFsmFor(existing.bookingModel);
      const { to } = await fsm.fire(existing.status as never, "GIVE_NOTICE", {} as BookingActivationContext);

      const updated = await tx.booking.update({
        where: { id: bookingId },
        data: { status: to, noticeGivenAt: new Date(), noticeEffectiveDate },
      });

      if (existing.termMonths) {
        const count = await voidScheduledInvoices(tx, bookingId, noticeEffectiveDate);
        await tx.bookingEvent.create({
          data: { tenantId: tenant.id, bookingId, fromStatus: existing.status, toStatus: to, actorType: "CUSTOMER", actorId: customerId, reason: `Termination notice given via portal — ${count} scheduled invoice(s) voided` },
        });
        return { booking: updated, finalInvoice: null, voided: count };
      }

      const invoice = await this.finance.generateFinalSettlement(
        tx,
        tenant.id,
        tenant.slug,
        tenant.isPkp,
        {
          id: updated.id,
          bookingModel: updated.bookingModel,
          customerId: updated.customerId,
          startDate: updated.startDate,
          anchorDay: updated.anchorDay,
          priceSnapshot: updated.priceSnapshot,
        },
        noticeEffectiveDate,
      );

      await tx.bookingEvent.create({
        data: {
          tenantId: tenant.id,
          bookingId,
          fromStatus: existing.status,
          toStatus: to,
          actorType: "CUSTOMER",
          actorId: customerId,
          reason: "Termination notice given via portal",
        },
      });

      return { booking: updated, finalInvoice: invoice, voided: 0 };
    });

    const customer = await this.crm.getById(tenant.id, customerId);
    await this.notifications.notifyCustomer({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      customer,
      templateKey: "notice_confirmed",
      variables: { noticeEffectiveDate: formatDateId(noticeEffectiveDate), finalInvoiceNumber: finalInvoice?.invoiceNumber ?? "", voidedInvoices: String(voided) },
      link: { purpose: "BOOKING", next: `/portal/bookings/${booking.id}` },
    });

    return { booking, finalInvoice };
  }
}
