import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CreateApiKeyRequestSchema } from "@rentos/contracts";

import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { Roles } from "../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../common/guards/roles.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { ApiKeysService } from "./api-keys.service.js";

@ApiTags("api-keys")
@Controller("api-keys")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("SUPER_ADMIN")
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Post()
  create(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(CreateApiKeyRequestSchema)) body: ReturnType<typeof CreateApiKeyRequestSchema.parse>,
  ) {
    return this.apiKeys.create(tenant, user.id, body.label);
  }

  @Get()
  list(@CurrentTenant() tenant: ResolvedTenant) {
    return this.apiKeys.list(tenant);
  }

  @Delete(":id")
  revoke(@CurrentTenant() tenant: ResolvedTenant, @Param("id") id: string) {
    return this.apiKeys.revoke(tenant, id);
  }
}
