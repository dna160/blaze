import { Controller, Get, Param, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { CurrentTenantId } from "../common/decorators/current-tenant.decorator.js";

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
  async availability(@CurrentTenantId() tenantId: string, @Param("id") id: string) {
    const availableCount = await this.catalog.availableCount(tenantId, id);
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
}
