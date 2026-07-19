import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { PlatformSignupRequestSchema } from "@rentos/contracts";

import { Roles } from "../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../common/guards/roles.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";

import { PlatformService } from "./platform.service.js";

@ApiTags("platform")
@Controller("platform")
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  /** Genuinely public — no guard. The actual self-serve tenant signup entry point (PRD Phase 4). */
  @Post("signup")
  signup(@Body(new ZodValidationPipe(PlatformSignupRequestSchema)) body: ReturnType<typeof PlatformSignupRequestSchema.parse>) {
    return this.platform.signup(body);
  }

  @Get("tenants")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("PLATFORM_ADMIN")
  listTenants() {
    return this.platform.listTenantSummaries();
  }

  @Post("billing/run")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("PLATFORM_ADMIN")
  runBilling() {
    return this.platform.runBillingNow();
  }

  @Get("billing/invoices")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("PLATFORM_ADMIN")
  listInvoices() {
    return this.platform.listInvoices();
  }

  @Post("billing/invoices/:id/mark-paid")
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles("PLATFORM_ADMIN")
  markPaid(@Param("id") id: string, @Body("tenantId") tenantId: string) {
    return this.platform.markInvoicePaid(tenantId, id);
  }
}
