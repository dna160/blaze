import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { assetFsm } from "@rentos/domain";
import { computePooledAvailableCount, findAvailablePooledAsset, recordDepositHeldEntries, type Prisma } from "@rentos/database";

import { AuditService } from "../audit/audit.service.js";
import { CrmService } from "../crm/crm.service.js";
import { FinanceService } from "../finance/finance.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { bookingFsmFor, GuardFailedError, type BookingActivationContext, type BookingStatus } from "./booking-fsm.util.js";

type TxBooking = { id: string; assetId: string | null; priceSnapshot: unknown; startDate: Date };

const DEFAULT_RESERVATION_TTL_HOURS = 48;

/** Booking models whose invoice math needs both ends of the window (nights/days x rate) — see BookingWindow.endDate. */
const BOOKING_MODELS_REQUIRING_END_DATE = new Set(["NIGHTLY", "DURATION_ORDER"]);

export interface CreateBookingInput {
  assetTypeId: string;
  startDate: Date;
  /** Checkout/return date — required for NIGHTLY and DURATION_ORDER, ignored otherwise. */
  endDate?: Date;
  customerPhone: string;
  customerFullName: string;
}

@Injectable()
export class BookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crm: CrmService,
    private readonly finance: FinanceService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  /** PRD §7.1.2 booking flow steps 1-5: pick AssetType, soft-reserve a unit, submit for approval. */
  async createBooking(tenant: ResolvedTenant, input: CreateBookingInput) {
    const customer = await this.crm.getOrCreateByPhone(tenant.id, input.customerPhone, input.customerFullName);

    const booking = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const assetType = await tx.assetType.findUnique({ where: { id: input.assetTypeId } });
      if (!assetType || !assetType.isPublished) throw new NotFoundException("AssetType not found.");

      if (BOOKING_MODELS_REQUIRING_END_DATE.has(assetType.bookingModel)) {
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
        const availableAsset = await tx.asset.findFirst({
          where: { assetTypeId: assetType.id, status: "AVAILABLE" },
          orderBy: { code: "asc" },
        });
        if (!availableAsset) {
          throw new ConflictException("No units of this type are currently available.");
        }
        availableAssetId = availableAsset.id;
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
          status: "DRAFT",
          startDate: input.startDate,
          endDate: BOOKING_MODELS_REQUIRING_END_DATE.has(assetType.bookingModel) ? input.endDate : undefined,
          priceSnapshot: assetType.pricing as Prisma.InputJsonValue,
          reservedUntil,
        },
      });

      const { to } = await fsm.fire("DRAFT", "SUBMIT", {} as BookingActivationContext);
      if (availableAssetId) {
        await assetFsm.fire("AVAILABLE", "RESERVE", undefined);
        await tx.asset.update({ where: { id: availableAssetId }, data: { status: "RESERVED" } });
      }

      const updated = await tx.booking.update({ where: { id: created.id }, data: { status: to } });
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

    await this.notifications.notify({
      tenantId: tenant.id,
      customerId: customer.id,
      channel: "WHATSAPP",
      templateKey: "booking_received",
      recipient: customer.phone,
      variables: { customerName: customer.fullName ?? "Customer", bookingId: booking.id },
    });

    return booking;
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

  async getBooking(tenantId: string, bookingId: string) {
    const booking = await this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.booking.findUnique({
        where: { id: bookingId },
        include: { customer: true, assetType: true, asset: true, events: { orderBy: { createdAt: "asc" } } },
      }),
    );
    if (!booking) throw new NotFoundException("Booking not found.");
    return booking;
  }

  listForCustomer(tenantId: string, customerId: string) {
    return this.prisma.runInTenantContext(tenantId, (tx) =>
      tx.booking.findMany({
        where: { customerId },
        include: { assetType: true, asset: true },
        orderBy: { createdAt: "desc" },
      }),
    );
  }

  /** Approval workbench: approve (PRD §7.2.1) — generates the first invoice and sends the payment link in one WA message (automation A3). */
  async approve(tenant: ResolvedTenant, bookingId: string, approverUserId: string, assetId?: string) {
    const { booking, invoice } = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const existing = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!existing) throw new NotFoundException("Booking not found.");

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
    await this.notifications.notify({
      tenantId: tenant.id,
      customerId: customer.id,
      channel: "WHATSAPP",
      templateKey: "booking_approved_payment_link",
      recipient: customer.phone,
      variables: { invoiceNumber: invoice.invoiceNumber, totalAmount: invoice.totalAmount.toString() },
    });
    await this.audit.record({
      tenantId: tenant.id,
      actorUserId: approverUserId,
      action: "BOOKING_APPROVED",
      entityType: "Booking",
      entityId: bookingId,
    });

    return { booking, invoice };
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
        await tx.asset.update({ where: { id: existing.assetId }, data: { status: "AVAILABLE" } });
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
    await this.notifications.notify({
      tenantId: tenant.id,
      customerId: customer.id,
      channel: "WHATSAPP",
      templateKey: "booking_rejected",
      recipient: customer.phone,
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
    const priceSnapshot = booking.priceSnapshot as { prorationRule?: "ANCHOR_DATE" | "FULL_FIRST_PERIOD" };
    const anchorDay = priceSnapshot.prorationRule === "FULL_FIRST_PERIOD" ? 1 : booking.startDate.getDate();
    await tx.booking.update({ where: { id: booking.id }, data: { status: to, anchorDay } });

    if (booking.assetId) {
      await assetFsm.fire("RESERVED", "MOVE_IN", undefined);
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

  /** Self-service portal: give notice (PRD §7.1.4) — enforces nothing beyond a valid FSM transition in v1; notice-period minimums are a tenant-config TODO (docs/HANDOFF.md). */
  async giveNotice(tenant: ResolvedTenant, bookingId: string, customerId: string, noticeEffectiveDate: Date) {
    const { booking, finalInvoice } = await this.prisma.runInTenantContext(tenant.id, async (tx) => {
      const existing = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!existing) throw new NotFoundException("Booking not found.");
      if (existing.customerId !== customerId) throw new BadRequestException("This booking does not belong to you.");

      const fsm = bookingFsmFor(existing.bookingModel);
      const { to } = await fsm.fire(existing.status as never, "GIVE_NOTICE", {} as BookingActivationContext);

      const updated = await tx.booking.update({
        where: { id: bookingId },
        data: { status: to, noticeGivenAt: new Date(), noticeEffectiveDate },
      });

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

      return { booking: updated, finalInvoice: invoice };
    });

    await this.notifications.notify({
      tenantId: tenant.id,
      customerId,
      channel: "WHATSAPP",
      templateKey: "notice_confirmed",
      recipient: (await this.crm.getById(tenant.id, customerId)).phone,
      variables: { noticeEffectiveDate: noticeEffectiveDate.toISOString(), finalInvoiceNumber: finalInvoice.invoiceNumber },
    });

    return { booking, finalInvoice };
  }
}
