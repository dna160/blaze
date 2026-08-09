import { Body, Controller, ForbiddenException, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ApproveBookingRequestSchema, CreateBookingRequestSchema, GiveNoticeRequestSchema, RejectBookingRequestSchema } from "@rentos/contracts";

import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RequireCapability } from "../common/decorators/require-capability.decorator.js";
import { CapabilityGuard } from "../common/guards/capability.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { BookingService } from "./booking.service.js";

@ApiTags("bookings")
@Controller("bookings")
export class BookingController {
  constructor(private readonly booking: BookingService) {}

  /** Public storefront submission — no auth (PRD §7.1.2: identity is established via OTP during checkout, not before). */
  @Post()
  create(
    @CurrentTenant() tenant: ResolvedTenant,
    @Body(new ZodValidationPipe(CreateBookingRequestSchema)) body: ReturnType<typeof CreateBookingRequestSchema.parse>,
  ) {
    return this.booking.createBooking(tenant, {
      assetTypeId: body.assetTypeId,
      startDate: new Date(body.startDate),
      endDate: body.endDate ? new Date(body.endDate) : undefined,
      customerPhone: body.customerPhone,
      customerFullName: body.customerFullName,
    });
  }

  @Get("mine")
  @UseGuards(JwtAuthGuard)
  listMine(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser) {
    if (user.kind !== "CUSTOMER") throw new ForbiddenException("Customer session required.");
    return this.booking.listForCustomer(tenant.id, user.id);
  }

  @Get("pending")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("approve_booking")
  listPending(@CurrentTenant() tenant: ResolvedTenant) {
    return this.booking.listPendingApproval(tenant.id);
  }

  @Get(":id")
  @UseGuards(JwtAuthGuard)
  get(@CurrentTenant() tenant: ResolvedTenant, @Param("id") id: string) {
    return this.booking.getBooking(tenant.id, id);
  }

  @Post(":id/approve")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("approve_booking")
  approve(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ApproveBookingRequestSchema)) body: ReturnType<typeof ApproveBookingRequestSchema.parse>,
  ) {
    return this.booking.approve(tenant, id, user.id, body.assetId);
  }

  @Post(":id/reject")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("approve_booking")
  reject(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(RejectBookingRequestSchema)) body: ReturnType<typeof RejectBookingRequestSchema.parse>,
  ) {
    return this.booking.reject(tenant, id, user.id, body.reason);
  }

  /** Staff check-in (PRD Appendix B, NIGHTLY): PAID -> CHECKED_IN. */
  @Post(":id/check-in")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("approve_booking")
  checkIn(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.booking.checkIn(tenant, id, user.id);
  }

  /** Staff check-out (PRD Appendix B, NIGHTLY): CHECKED_IN -> CHECKED_OUT -> CLOSED. */
  @Post(":id/check-out")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("approve_booking")
  checkOut(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.booking.checkOut(tenant, id, user.id);
  }

  /** Staff pickup (PRD Appendix B, DURATION_ORDER): PAID -> PICKED_UP. */
  @Post(":id/pickup")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("approve_booking")
  pickUp(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.booking.pickUp(tenant, id, user.id);
  }

  /** Staff return (PRD Appendix B, DURATION_ORDER): PICKED_UP -> RETURNED -> INSPECTION. */
  @Post(":id/return")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("approve_booking")
  returnEquipment(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.booking.returnEquipment(tenant, id, user.id);
  }

  /** Staff inspection complete (PRD Appendix B, DURATION_ORDER): INSPECTION -> CLOSED. */
  @Post(":id/complete-inspection")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("approve_booking")
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
