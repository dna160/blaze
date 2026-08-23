import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  CreateAssetRequestSchema,
  CreateAssetTypeRequestSchema,
  RateTierSchema,
  StorageAvailabilityQuerySchema,
  TermMonthsSchema,
  UpdateAssetStatusRequestSchema,
  UpdateAssetTypeRequestSchema,
  UpsertLocationRequestSchema,
} from "@rentos/contracts";

import { CurrentTenant, CurrentTenantId } from "../common/decorators/current-tenant.decorator.js";
import { RequireCapability } from "../common/decorators/require-capability.decorator.js";
import { CapabilityGuard } from "../common/guards/capability.guard.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { StaffGuard } from "../common/guards/staff.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

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

  // Must be registered before "asset-types/:id" — Nest/Express matches
  // routes in declaration order, so the literal "all" segment would
  // otherwise be swallowed by the :id param route below.
  /** Staff-only — includes unpublished/draft AssetTypes, unlike the public list above. See CatalogService.listAllAssetTypes. */
  @Get("asset-types/all")
  @UseGuards(JwtAuthGuard, StaffGuard)
  listAllAssetTypes(@CurrentTenantId() tenantId: string) {
    return this.catalog.listAllAssetTypes(tenantId);
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

  /** Live price preview — term proforma + full schedule for storage (PRD v2 D1), legacy tiers for everything else. See CatalogService.quote. */
  @Get("asset-types/:id/quote")
  async quote(
    @CurrentTenant() tenant: ResolvedTenant,
    @Param("id") id: string,
    @Query("startDate") startDate: string,
    @Query("endDate") endDate?: string,
    @Query("rateTier") rateTierRaw?: string,
    @Query("termMonths") termMonthsRaw?: string,
  ) {
    const rateTier = rateTierRaw ? RateTierSchema.parse(rateTierRaw) : undefined;
    const termMonths = termMonthsRaw ? TermMonthsSchema.parse(Number(termMonthsRaw)) : undefined;
    return this.catalog.quote(tenant, id, { startDate, endDate, rateTier, termMonths });
  }

  /** PRD v2 §4.3 — storefront step 3 live availability check (public, same trust level as the catalog). */
  @Get("availability")
  storageAvailability(@CurrentTenant() tenant: ResolvedTenant, @Query(new ZodValidationPipe(StorageAvailabilityQuerySchema)) query: ReturnType<typeof StorageAvailabilityQuerySchema.parse>) {
    return this.catalog.storageAvailability(tenant, query);
  }

  @Get("locations")
  listLocations(@CurrentTenantId() tenantId: string) {
    return this.catalog.listLocations(tenantId);
  }

  /** PRD v2 §4.1 storefront step 2 — sizes sold at a branch with live counts (public). */
  @Get("locations/:id/asset-types")
  locationAssetTypes(@CurrentTenant() tenant: ResolvedTenant, @Param("id") id: string) {
    return this.catalog.locationAssetTypes(tenant, id);
  }

  @Post("locations")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("manage_users")
  createLocation(
    @CurrentTenantId() tenantId: string,
    @Body(new ZodValidationPipe(UpsertLocationRequestSchema)) body: ReturnType<typeof UpsertLocationRequestSchema.parse>,
  ) {
    return this.catalog.createLocation(tenantId, body);
  }

  @Patch("locations/:id")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("manage_users")
  updateLocation(
    @CurrentTenantId() tenantId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpsertLocationRequestSchema)) body: ReturnType<typeof UpsertLocationRequestSchema.parse>,
  ) {
    return this.catalog.updateLocation(tenantId, id, body);
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
  @UseGuards(JwtAuthGuard, StaffGuard)
  unitMap(@CurrentTenantId() tenantId: string, @Query("locationId") locationId?: string) {
    return this.catalog.unitMap(tenantId, { locationId });
  }

  /** Catalog setup (Session 23) — staff create/edit their own AssetType/Asset rows instead of seed data or a direct DB edit. */
  @Post("asset-types")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("manage_users")
  createAssetType(
    @CurrentTenantId() tenantId: string,
    @Body(new ZodValidationPipe(CreateAssetTypeRequestSchema)) body: ReturnType<typeof CreateAssetTypeRequestSchema.parse>,
  ) {
    return this.catalog.createAssetType(tenantId, body);
  }

  @Patch("asset-types/:id")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("manage_users")
  updateAssetType(
    @CurrentTenantId() tenantId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateAssetTypeRequestSchema)) body: ReturnType<typeof UpdateAssetTypeRequestSchema.parse>,
  ) {
    return this.catalog.updateAssetType(tenantId, id, body);
  }

  @Post("assets")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("manage_users")
  createAsset(
    @CurrentTenantId() tenantId: string,
    @Body(new ZodValidationPipe(CreateAssetRequestSchema)) body: ReturnType<typeof CreateAssetRequestSchema.parse>,
  ) {
    return this.catalog.createAsset(tenantId, body);
  }

  @Patch("assets/:id/status")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("manage_users")
  updateAssetStatus(
    @CurrentTenantId() tenantId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateAssetStatusRequestSchema)) body: ReturnType<typeof UpdateAssetStatusRequestSchema.parse>,
  ) {
    return this.catalog.updateAssetStatus(tenantId, id, body.status, body.statusReason);
  }
}
