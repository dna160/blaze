import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { PlatformSignupRequestSchema } from "@rentos/contracts";

import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { PlatformAdminGuard } from "../common/guards/platform-admin.guard.js";
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
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  listTenants() {
    return this.platform.listTenantSummaries();
  }

  @Post("billing/run")
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  runBilling() {
    return this.platform.runBillingNow();
  }

  @Get("billing/invoices")
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  listInvoices() {
    return this.platform.listInvoices();
  }

  @Post("billing/invoices/:id/mark-paid")
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  markPaid(@Param("id") id: string, @Body("tenantId") tenantId: string) {
    return this.platform.markInvoicePaid(tenantId, id);
  }
}
