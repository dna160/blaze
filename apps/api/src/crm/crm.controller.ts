import { Body, Controller, Get, Param, Patch, Query, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ClientListQuerySchema } from "@rentos/contracts";

import { CurrentTenantId } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { Roles } from "../common/decorators/roles.decorator.js";
import { RolesGuard } from "../common/guards/roles.guard.js";
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

  /** PRD v2 §5.2 client list — search/filter/status. Declared before :id for the same reason as "me". */
  @Get("clients")
  @UseGuards(RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN", "VIEWER")
  listClients(
    @CurrentTenantId() tenantId: string,
    @Query(new ZodValidationPipe(ClientListQuerySchema)) query: ReturnType<typeof ClientListQuerySchema.parse>,
  ) {
    return this.crm.listClients(tenantId, query);
  }

  @Get("clients/:id")
  @UseGuards(RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN", "VIEWER")
  getClientDetail(@CurrentTenantId() tenantId: string, @Param("id") id: string) {
    return this.crm.getClientDetail(tenantId, id);
  }

  @Get()
  @UseGuards(RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN", "VIEWER")
  list(@CurrentTenantId() tenantId: string) {
    return this.crm.listCustomers(tenantId);
  }

  @Get(":id")
  @UseGuards(RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN", "VIEWER")
  get(@CurrentTenantId() tenantId: string, @Param("id") id: string) {
    return this.crm.getById(tenantId, id);
  }

  @Patch(":id/blocklist")
  @UseGuards(RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN")
  setBlocklist(
    @CurrentTenantId() tenantId: string,
    @Param("id") id: string,
    @Body() body: { isBlocklisted: boolean; reason?: string },
  ) {
    return this.crm.setBlocklist(tenantId, id, body.isBlocklisted, body.reason);
  }
}
