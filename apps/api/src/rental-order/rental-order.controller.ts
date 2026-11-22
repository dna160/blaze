import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { CapabilityGuard } from "../common/guards/capability.guard.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { StaffGuard } from "../common/guards/staff.guard.js";
import { RequireCapability } from "../common/decorators/require-capability.decorator.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { RentalOrderService } from "./rental-order.service.js";

@ApiTags("rental-orders")
@Controller("rental-orders")
export class RentalOrderController {
  constructor(private readonly orders: RentalOrderService) {}

  /** Customer request-to-book: asset TYPE + whole months, no unit chosen (#11, C3). */
  @Post()
  @UseGuards(JwtAuthGuard)
  create(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { assetTypeId: string; months: number; periodStart: string; masterAgreementId?: string },
  ) {
    if (user.kind !== "CUSTOMER") throw new ForbiddenException("Customer session required.");
    return this.orders.createOrder(tenant, {
      customerId: user.id,
      assetTypeId: body.assetTypeId,
      months: body.months,
      periodStart: new Date(body.periodStart),
      masterAgreementId: body.masterAgreementId,
    });
  }

  @Get("pending")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("approve_booking")
  pending(@CurrentTenant() tenant: ResolvedTenant) {
    return this.orders.listPending(tenant);
  }

  /** PRD go-live 2 §10.2 — the console's rental-orders list. `?status=ACTIVE&search=…` (unit, customer name/phone/number). */
  @Get()
  @UseGuards(JwtAuthGuard, StaffGuard)
  list(@CurrentTenant() tenant: ResolvedTenant, @Query("status") status?: string, @Query("search") search?: string) {
    return this.orders.listForConsole(tenant, { status, search });
  }

  /** PRD go-live 2 §10.2 — one order with its customer, unit, invoices, contracts, events and renewal chain. */
  @Get(":id/detail")
  @UseGuards(JwtAuthGuard, StaffGuard)
  detail(@CurrentTenant() tenant: ResolvedTenant, @Param("id") id: string) {
    return this.orders.detailForConsole(tenant, id);
  }

  /** Staff read any order of the branch; a customer only their own (it carries invoices and contracts). */
  @Get(":id")
  @UseGuards(JwtAuthGuard)
  async get(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const order = await this.orders.get(tenant, id);
    if (user.kind === "CUSTOMER" && order.customerId !== user.id) throw new NotFoundException("Rental order not found.");
    return order;
  }

  /** Staff approve + assign the specific unit, issuing contract + invoice. */
  @Post(":id/approve")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("approve_booking")
  approve(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: { assetId: string },
  ) {
    return this.orders.approve(tenant, id, user.id, body.assetId);
  }

  /** Staff end a rental now and free its unit (no waitlist side effect). Body: { reason }. */
  @Post(":id/end")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("approve_booking")
  end(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: { reason?: string },
  ) {
    const reason = body?.reason?.trim();
    if (!reason) throw new BadRequestException("Say why the rental is being ended.");
    return this.orders.endRental(tenant, id, user.id, reason.slice(0, 300));
  }

  /** H-14 offer (staff/system can trigger manually; the worker triggers it automatically). */
  @Post(":id/offer-renewal")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("approve_booking")
  offerRenewal(@CurrentTenant() tenant: ResolvedTenant, @Param("id") id: string) {
    return this.orders.offerRenewal(tenant, id);
  }

  @Post(":id/confirm-renewal")
  @UseGuards(JwtAuthGuard)
  async confirmRenewal(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.assertOwner(tenant, user, id);
    return this.orders.confirmRenewal(tenant, id);
  }

  @Post(":id/decline-renewal")
  @UseGuards(JwtAuthGuard)
  async declineRenewal(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    await this.assertOwner(tenant, user, id);
    return this.orders.declineRenewal(tenant, id);
  }

  private async assertOwner(tenant: ResolvedTenant, user: AuthenticatedUser, id: string): Promise<void> {
    if (user.kind === "STAFF") return; // staff may act on behalf
    const order = await this.orders.get(tenant, id);
    if (order.customerId !== user.id) throw new ForbiddenException("This order does not belong to you.");
  }
}
