import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { CurrentTenantId } from "../common/decorators/current-tenant.decorator.js";
import { Roles } from "../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../common/guards/roles.guard.js";

import { CatalogService } from "./catalog.service.js";

/** Public storefront catalog — no auth required (PRD §7.1.1: "prices visible without login"). */
@ApiTags("catalog")
@Controller("catalog")
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get("asset-types")
  listAssetTypes(@CurrentTenantId() tenantId: string) {
    return this.catalog.listPublishedAssetTypes(tenantId);
  }

  @Get("asset-types/:id")
  getAssetType(@CurrentTenantId() tenantId: string, @Param("id") id: string) {
    return this.catalog.getAssetType(tenantId, id);
  }

  @Get("asset-types/:id/availability")
  async availability(
    @CurrentTenantId() tenantId: string,
    @Param("id") id: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    const window = startDate && endDate ? { startDate: new Date(startDate), endDate: new Date(endDate) } : undefined;
    const availableCount = await this.catalog.availableCount(tenantId, id, window);
    return { assetTypeId: id, availableCount };
  }

  @Get("locations")
  listLocations(@CurrentTenantId() tenantId: string) {
    return this.catalog.listLocations(tenantId);
  }

  @Get("assets")
  listAssets(
    @CurrentTenantId() tenantId: string,
    @Query("locationId") locationId?: string,
    @Query("assetTypeId") assetTypeId?: string,
    @Query("status") status?: string,
  ) {
    return this.catalog.listAssets(tenantId, { locationId, assetTypeId, status });
  }

  /** Staff-only — includes occupant PII, unlike the public asset list above. See CatalogService.unitMap. */
  @Get("assets/unit-map")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN", "VIEWER")
  unitMap(@CurrentTenantId() tenantId: string, @Query("locationId") locationId?: string) {
    return this.catalog.unitMap(tenantId, { locationId });
  }
}
