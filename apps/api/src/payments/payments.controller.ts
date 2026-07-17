import { Body, Controller, ForbiddenException, Headers, Param, Post, Req, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { InitiatePaymentRequestSchema, RecordManualPaymentRequestSchema } from "@rentos/contracts";
import type { Request } from "express";

import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { Roles } from "../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../common/guards/roles.guard.js";
import { TenantMatchGuard } from "../common/guards/tenant-match.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { PaymentsService } from "./payments.service.js";

@ApiTags("payments")
@Controller("payments")
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly tenancy: TenancyService,
  ) {}

  @Post("initiate")
  @UseGuards(JwtAuthGuard, TenantMatchGuard)
  initiate(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(InitiatePaymentRequestSchema)) body: ReturnType<typeof InitiatePaymentRequestSchema.parse>,
  ) {
    if (user.kind !== "CUSTOMER") throw new ForbiddenException("Customer session required.");
    return this.payments.initiate(tenant, body.invoiceId, body.method);
  }

  /** PRD §7.2.4: Super Admin / Ops Admin record manual payments (RBAC Appendix C). Never finalizes by itself — see verify(). */
  @Post("manual")
  @UseGuards(JwtAuthGuard, RolesGuard, TenantMatchGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN")
  recordManual(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(RecordManualPaymentRequestSchema)) body: ReturnType<typeof RecordManualPaymentRequestSchema.parse>,
  ) {
    return this.payments.recordManual(tenant, user.id, body.invoiceId, body.method, body.proofUrl);
  }

  /** PRD §7.2.4 maker-checker: Finance Admin (or Super Admin) verifies — never the recorder. */
  @Post(":id/verify")
  @UseGuards(JwtAuthGuard, RolesGuard, TenantMatchGuard)
  @Roles("SUPER_ADMIN", "FINANCE_ADMIN")
  verifyManual(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.payments.verifyManual(tenant, user.id, id);
  }

  /**
   * Gateway webhook URLs are registered per tenant and hit this fixed API
   * domain directly (they do not carry the tenant's storefront subdomain),
   * so the tenant is resolved from the path, not from Host/JWT like every
   * other endpoint in this API.
   */
  @Post("webhook/:tenantSlug")
  async webhook(
    @Param("tenantSlug") tenantSlug: string,
    @Req() req: Request,
    @Headers() headers: Record<string, string>,
  ) {
    const tenant = await this.tenancy.resolveBySlug(tenantSlug);
    return this.payments.handleWebhook(tenant, JSON.stringify(req.body), headers);
  }
}
