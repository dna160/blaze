import { Body, Controller, Delete, Get, Param, Post, Res, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CreateOtaSubscriptionRequestSchema } from "@rentos/contracts";
import type { Response } from "express";

import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { Roles } from "../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../common/guards/roles.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { OtaSyncService } from "./ota-sync.service.js";

@ApiTags("ota-sync")
@Controller("ota")
export class OtaSyncController {
  constructor(private readonly otaSync: OtaSyncService) {}

  /**
   * Public, unauthenticated — same trust level as public catalog
   * browsing (PRD §7.1.1). Exposes only date ranges, never customer PII,
   * so a tenant can paste this URL directly into Airbnb/Booking.com's
   * "import calendar" field. Tenant is still resolved via the usual
   * X-Tenant-Slug/Host (TenantMiddleware), so the feature flag check and
   * RLS scoping both still apply — a tenant without ota_sync_enabled
   * gets a 403, not a leaked feed.
   */
  @Get("assets/:assetId/calendar.ics")
  async calendarFeed(@CurrentTenant() tenant: ResolvedTenant, @Param("assetId") assetId: string, @Res() res: Response) {
    const ics = await this.otaSync.generateFeed(tenant, assetId);
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.send(ics);
  }

  @Post("subscriptions")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("SUPER_ADMIN")
  create(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreateOtaSubscriptionRequestSchema))
    body: ReturnType<typeof CreateOtaSubscriptionRequestSchema.parse>,
  ) {
    return this.otaSync.createSubscription(tenant, user.id, body.assetId, body.label, body.sourceUrl);
  }

  @Get("subscriptions")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("SUPER_ADMIN")
  list(@CurrentTenant() tenant: ResolvedTenant) {
    return this.otaSync.list(tenant);
  }

  @Delete("subscriptions/:id")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("SUPER_ADMIN")
  remove(@CurrentTenant() tenant: ResolvedTenant, @Param("id") id: string) {
    return this.otaSync.remove(tenant, id);
  }
}
