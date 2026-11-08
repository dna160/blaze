import { Body, Controller, ForbiddenException, Get, Param, Patch, Query, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ClientListQuerySchema, StaffTaxProfileRequestSchema, UpdateTaxProfileRequestSchema } from "@rentos/contracts";
import { can } from "@rentos/domain";

import { CurrentTenantId } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RequireCapability } from "../common/decorators/require-capability.decorator.js";
import { CapabilityGuard } from "../common/guards/capability.guard.js";
import { StaffGuard } from "../common/guards/staff.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";

import { CrmService } from "./crm.service.js";

@ApiTags("crm")
@Controller("customers")
@UseGuards(JwtAuthGuard)
export class CrmController {
  constructor(private readonly crm: CrmService) {}

  /** PRD §7.1.4 customer portal profile — must be declared before :id so "me" isn't swallowed by the param route. */
  @Get("me")
  getMe(@CurrentTenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.crm.getById(tenantId, user.id);
  }

  /**
   * The customer's own answer to "Apakah dibebankan PPh?" (plus NPWP/NIB if
   * typed). Customer-session only and scoped to themselves — there is no id in
   * the path, so one customer cannot set another's tax profile. Declared before
   * ":id" for the same reason "me" is.
   */
  @Patch("me/tax-profile")
  setMyTaxProfile(
    @CurrentTenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(UpdateTaxProfileRequestSchema)) body: ReturnType<typeof UpdateTaxProfileRequestSchema.parse>,
  ) {
    if (user.kind !== "CUSTOMER") throw new ForbiddenException("Customer session required.");
    return this.crm.setTaxProfile(tenantId, user.id, body);
  }

  /** PRD v2 §5.2 client list — search/filter/status. Declared before :id for the same reason as "me". */
  @Get("clients")
  @UseGuards(StaffGuard)
  listClients(
    @CurrentTenantId() tenantId: string,
    @Query(new ZodValidationPipe(ClientListQuerySchema)) query: ReturnType<typeof ClientListQuerySchema.parse>,
  ) {
    return this.crm.listClients(tenantId, query);
  }

  @Get("clients/:id")
  @UseGuards(StaffGuard)
  getClientDetail(@CurrentTenantId() tenantId: string, @Param("id") id: string) {
    return this.crm.getClientDetail(tenantId, id);
  }

  @Get()
  @UseGuards(StaffGuard)
  list(@CurrentTenantId() tenantId: string) {
    return this.crm.listCustomers(tenantId);
  }

  @Get(":id")
  @UseGuards(StaffGuard)
  get(@CurrentTenantId() tenantId: string, @Param("id") id: string) {
    return this.crm.getById(tenantId, id);
  }

  /** PRD go-live §7.4 — the client page's document vault. KYC files only for roles that review KYC. */
  @Get(":id/documents")
  @UseGuards(StaffGuard)
  documents(@CurrentTenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    const includeKyc = can(user.roleAssignments, "approve_booking", tenantId) || can(user.roleAssignments, "approve_deposit_refund", tenantId);
    return this.crm.listDocuments(tenantId, id, { includeKyc });
  }

  /** PRD go-live §8.2 — staff set/correct the PPh answer and type (and NPWP/address), audited. */
  @Patch(":id/tax-profile")
  @UseGuards(CapabilityGuard)
  @RequireCapability("approve_booking", "record_payment")
  setTaxProfileByStaff(
    @CurrentTenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(StaffTaxProfileRequestSchema)) body: ReturnType<typeof StaffTaxProfileRequestSchema.parse>,
  ) {
    return this.crm.setTaxProfileByStaff(tenantId, id, user.id, body);
  }

  @Patch(":id/blocklist")
  @UseGuards(CapabilityGuard)
  @RequireCapability("approve_booking")
  setBlocklist(
    @CurrentTenantId() tenantId: string,
    @Param("id") id: string,
    @Body() body: { isBlocklisted: boolean; reason?: string },
  ) {
    return this.crm.setBlocklist(tenantId, id, body.isBlocklisted, body.reason);
  }
}
