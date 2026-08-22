import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CreateStaffUserRequestSchema, UpdateStaffRoleRequestSchema } from "@rentos/contracts";

import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { CapabilityGuard } from "../common/guards/capability.guard.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RequireCapability } from "../common/decorators/require-capability.decorator.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { UsersService } from "./users.service.js";

/**
 * BUILD-SPEC C2 — staff user & role administration. Every route is manage_users
 * (ADMIN) gated. Granting an organization-wide role additionally requires the
 * caller to be organization-scoped (enforced in the service).
 */
@ApiTags("users")
@Controller("users")
@UseGuards(JwtAuthGuard, CapabilityGuard)
@RequireCapability("manage_users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @CurrentTenant() tenant: ResolvedTenant) {
    return this.users.listUsers(user, tenant);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: ResolvedTenant,
    @Body(new ZodValidationPipe(CreateStaffUserRequestSchema)) body: ReturnType<typeof CreateStaffUserRequestSchema.parse>,
  ) {
    return this.users.createUser(user, tenant, body);
  }

  @Patch(":id/role")
  updateRole(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: ResolvedTenant,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateStaffRoleRequestSchema)) body: ReturnType<typeof UpdateStaffRoleRequestSchema.parse>,
  ) {
    return this.users.updateUserRole(user, tenant, id, body);
  }

  @Patch(":id/status")
  setStatus(
    @CurrentUser() user: AuthenticatedUser,
    @CurrentTenant() tenant: ResolvedTenant,
    @Param("id") id: string,
    @Body() body: { active: boolean },
  ) {
    return this.users.setStatus(user, tenant, id, body.active);
  }
}
