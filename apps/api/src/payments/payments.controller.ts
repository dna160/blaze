import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiTags } from "@nestjs/swagger";
import { InitiatePaymentRequestSchema } from "@rentos/contracts";
import type { Request, Response } from "express";

import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RequireCapability } from "../common/decorators/require-capability.decorator.js";
import { CapabilityGuard } from "../common/guards/capability.guard.js";
import { StaffGuard } from "../common/guards/staff.guard.js";
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
  @UseGuards(JwtAuthGuard)
  initiate(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(InitiatePaymentRequestSchema)) body: ReturnType<typeof InitiatePaymentRequestSchema.parse>,
  ) {
    if (user.kind !== "CUSTOMER") throw new ForbiddenException("Customer session required.");
    return this.payments.initiate(tenant, body.invoiceId, body.method);
  }

  /** PRD §7.2.4: Super Admin / Ops Admin record manual payments with a proof-of-payment upload (RBAC Appendix C). Never finalizes by itself — see verify(). */
  @Post("manual")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("record_payment")
  @UseInterceptors(FileInterceptor("file"))
  recordManual(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body("invoiceId") invoiceId: string,
    @Body("method") method: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (method !== "CASH" && method !== "MANUAL_TRANSFER") {
      throw new BadRequestException('method must be "CASH" or "MANUAL_TRANSFER".');
    }
    if (!invoiceId) throw new BadRequestException("invoiceId is required.");
    if (!file) throw new BadRequestException("No proof-of-payment file uploaded.");
    return this.payments.recordManual(tenant, user.id, invoiceId, method, {
      buffer: file.buffer,
      mimetype: file.mimetype,
      size: file.size,
    });
  }

  /** PRD §7.2.4 maker-checker: Finance Admin (or Super Admin) verifies — never the recorder. */
  @Post(":id/verify")
  @UseGuards(JwtAuthGuard, CapabilityGuard)
  @RequireCapability("verify_payment")
  verifyManual(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.payments.verifyManual(tenant, user.id, id);
  }

  /** Staff-only proof-of-payment preview (recorder, verifier, or any Finance/Ops role). */
  @Get(":id/file")
  @UseGuards(JwtAuthGuard, StaffGuard)
  async getFile(@CurrentTenant() tenant: ResolvedTenant, @Param("id") id: string, @Res() res: Response) {
    const result = await this.payments.getProofFile(tenant, id);
    if (result.kind === "redirect") {
      res.redirect(result.url);
      return;
    }
    res.setHeader("Content-Type", result.contentType);
    res.send(result.buffer);
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
