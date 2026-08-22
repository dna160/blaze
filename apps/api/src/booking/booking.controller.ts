import { Body, Controller, ForbiddenException, Get, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ApproveBookingRequestSchema, CreateBookingRequestSchema, GiveNoticeRequestSchema, RejectBookingRequestSchema } from "@rentos/contracts";
import type { Request } from "express";

import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { OptionalJwtAuthGuard } from "../common/guards/optional-jwt-auth.guard.js";
import { Roles } from "../common/decorators/roles.decorator.js";
import { RolesGuard } from "../common/guards/roles.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { BookingService } from "./booking.service.js";

@ApiTags("bookings")
@Controller("bookings")
export class BookingController {
  constructor(private readonly booking: BookingService) {}

  /**
   * Public storefront submission — no auth required (PRD §7.1.2: identity
   * is established via OTP during checkout, not before). Since PRD v2 a
   * session (OTP or Google) is honored when present so the booking lands
   * on that customer; see OptionalJwtAuthGuard.
   */
  @Post()
  @UseGuards(OptionalJwtAuthGuard)
  create(
    @CurrentTenant() tenant: ResolvedTenant,
    @Req() req: Request,
    @Body(new ZodValidationPipe(CreateBookingRequestSchema)) body: ReturnType<typeof CreateBookingRequestSchema.parse>,
  ) {
    const session = req.user?.kind === "CUSTOMER" ? req.user.id : undefined;
    if (body.extendsBookingId && !session) throw new ForbiddenException("Sign in to extend an existing rental.");
    return this.booking.createBooking(tenant, {
      assetTypeId: body.assetTypeId,
      startDate: new Date(body.startDate),
      endDate: body.endDate ? new Date(body.endDate) : undefined,
      rateTier: body.rateTier,
      locationId: body.locationId,
      termMonths: body.termMonths,
      extendsBookingId: body.extendsBookingId,
      customerPhone: body.customerPhone,
      customerFullName: body.customerFullName,
      authenticatedCustomerId: session,
    });
  }

  @Get("mine")
  @UseGuards(JwtAuthGuard)
  listMine(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser) {
    if (user.kind !== "CUSTOMER") throw new ForbiddenException("Customer session required.");
    return this.booking.listForCustomer(tenant.id, user.id);
  }

  @Get("pending")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN")
  listPending(@CurrentTenant() tenant: ResolvedTenant) {
    return this.booking.listPendingApproval(tenant.id);
  }

  /** PRD v2 §5.1 — the approval pipeline board: every pre-activation booking with its derived stage. */
  @Get("pipeline")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN", "VIEWER")
  listPipeline(@CurrentTenant() tenant: ResolvedTenant) {
    return this.booking.listPipeline(tenant);
  }

  @Get(":id")
  @UseGuards(JwtAuthGuard)
  async get(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const booking = await this.booking.getBooking(tenant.id, id);
    if (user.kind === "CUSTOMER" && booking.customerId !== user.id) throw new ForbiddenException("This booking does not belong to you.");
    return booking;
  }

  @Post(":id/approve")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN")
  approve(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ApproveBookingRequestSchema)) body: ReturnType<typeof ApproveBookingRequestSchema.parse>,
  ) {
    return this.booking.approve(tenant, id, user.id, body.assetId);
  }

  @Post(":id/reject")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN")
  reject(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(RejectBookingRequestSchema)) body: ReturnType<typeof RejectBookingRequestSchema.parse>,
  ) {
    return this.booking.reject(tenant, id, user.id, body.reason);
  }

  /** PRD v2 §5.1 stage 2 — send/re-send the KYC request (magic link into the upload page). */
  @Post(":id/request-kyc")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN")
  requestKyc(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.booking.requestKyc(tenant, id, user.id);
  }

  /** PRD v2 §5.1 stage 3 — rental agreement + full payment schedule (proforma now, later cycles SCHEDULED). */
  @Post(":id/generate-contract")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN")
  generateContract(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.booking.generateContractAndProforma(tenant, id, user.id);
  }

  /** PRD v2 §5.1 waitlist — offer a now-free unit to a waitlisted customer; re-enters approval. */
  @Post(":id/offer-unit")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN")
  offerUnit(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ApproveBookingRequestSchema)) body: ReturnType<typeof ApproveBookingRequestSchema.parse>,
  ) {
    return this.booking.offerUnit(tenant, id, user.id, body.assetId);
  }

  /** Staff check-in (PRD Appendix B, NIGHTLY): PAID -> CHECKED_IN. */
  @Post(":id/check-in")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN")
  checkIn(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.booking.checkIn(tenant, id, user.id);
  }

  /** Staff check-out (PRD Appendix B, NIGHTLY): CHECKED_IN -> CHECKED_OUT -> CLOSED. */
  @Post(":id/check-out")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN")
  checkOut(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.booking.checkOut(tenant, id, user.id);
  }

  /** Staff pickup (PRD Appendix B, DURATION_ORDER): PAID -> PICKED_UP. */
  @Post(":id/pickup")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN")
  pickUp(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.booking.pickUp(tenant, id, user.id);
  }

  /** Staff return (PRD Appendix B, DURATION_ORDER): PICKED_UP -> RETURNED -> INSPECTION. */
  @Post(":id/return")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN")
  returnEquipment(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.booking.returnEquipment(tenant, id, user.id);
  }

  /** Staff inspection complete (PRD Appendix B, DURATION_ORDER): INSPECTION -> CLOSED. */
  @Post(":id/complete-inspection")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN")
  completeInspection(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.booking.completeInspection(tenant, id, user.id);
  }

  @Post(":id/notice")
  @UseGuards(JwtAuthGuard)
  giveNotice(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(GiveNoticeRequestSchema)) body: ReturnType<typeof GiveNoticeRequestSchema.parse>,
  ) {
    if (user.kind !== "CUSTOMER") throw new ForbiddenException("Customer session required.");
    return this.booking.giveNotice(tenant, id, user.id, new Date(body.noticeEffectiveDate));
  }
}
