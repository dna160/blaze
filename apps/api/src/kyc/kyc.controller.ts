import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiTags } from "@nestjs/swagger";
import { DecideKycRequestSchema, KycDocumentTypeSchema, ReviewKycDocumentRequestSchema } from "@rentos/contracts";
import type { Request, Response } from "express";

import { CurrentTenant, CurrentTenantId } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RequireCapability } from "../common/decorators/require-capability.decorator.js";
import { CapabilityGuard } from "../common/guards/capability.guard.js";
import { StaffGuard } from "../common/guards/staff.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { KycService } from "./kyc.service.js";

@ApiTags("kyc")
@Controller("kyc")
@UseGuards(JwtAuthGuard)
export class KycController {
  constructor(private readonly kyc: KycService) {}

  /** PRD §7.1.2 step 4 — customer uploads KTP/selfie from the storefront portal. */
  @Post("documents")
  @UseInterceptors(FileInterceptor("file"))
  async upload(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Body("documentType") documentType: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (user.kind !== "CUSTOMER") throw new ForbiddenException("Customer session required.");
    if (!file) throw new BadRequestException("No file uploaded.");
    // Validated against the shared enum rather than a hardcoded pair, so adding
    // a document type in one place cannot leave this endpoint rejecting it.
    const parsed = KycDocumentTypeSchema.safeParse(documentType);
    if (!parsed.success) {
      throw new BadRequestException(
        `documentType must be one of: ${KycDocumentTypeSchema.options.join(", ")}.`,
      );
    }
    return this.kyc.upload(tenant, user.id, parsed.data, {
      buffer: file.buffer,
      mimetype: file.mimetype,
      size: file.size,
    });
  }

  @Get("documents/mine")
  listMine(@CurrentTenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser) {
    if (user.kind !== "CUSTOMER") throw new ForbiddenException("Customer session required.");
    return this.kyc.listMine(tenantId, user.id);
  }

  /** PRD §7.2.1 approval workbench context / §8.4 automation A9: staff review queue. */
  @Get("documents")
  @UseGuards(CapabilityGuard)
  @RequireCapability("approve_booking", "approve_deposit_refund")
  listForReview(@CurrentTenantId() tenantId: string, @Query("status") status?: string) {
    return this.kyc.listForReview(tenantId, { status });
  }

  @Get("documents/:id/file")
  @UseGuards(CapabilityGuard)
  @RequireCapability("approve_booking", "approve_deposit_refund")
  async getFile(@CurrentTenantId() tenantId: string, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Req() req: Request, @Res() res: Response) {
    // PRD go-live §7.4 — any status opens (approved files included), and every open is audited.
    const result = await this.kyc.getFile(tenantId, id, { actorUserId: user.id, ipAddress: req.ip ?? null });
    if (result.kind === "redirect") {
      res.redirect(result.url);
      return;
    }
    res.setHeader("Content-Type", result.contentType);
    res.send(result.buffer);
  }

  /* ---------------- PRD go-live 2 §5.1 — staff-assisted KYC ---------------- */

  /** What is on file for a customer, what is required, what is missing. No file contents — any staff may read it. */
  @Get("customers/:customerId")
  @UseGuards(StaffGuard)
  customerSummary(@CurrentTenantId() tenantId: string, @Param("customerId") customerId: string) {
    return this.kyc.customerSummary(tenantId, customerId);
  }

  /** Staff take a walk-in's documents at the counter: multipart `file`, `documentType`, optional `bookingId`. */
  @Post("customers/:customerId/documents")
  @UseGuards(CapabilityGuard)
  @RequireCapability("upload_kyc_on_behalf", "approve_booking")
  @UseInterceptors(FileInterceptor("file"))
  async uploadOnBehalf(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("customerId") customerId: string,
    @Body("documentType") documentType: string,
    @Body("bookingId") bookingId: string | undefined,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (user.kind !== "STAFF") throw new ForbiddenException("Staff session required.");
    if (!file) throw new BadRequestException("No file uploaded.");
    const parsed = KycDocumentTypeSchema.safeParse(documentType);
    if (!parsed.success) {
      throw new BadRequestException(`documentType must be one of: ${KycDocumentTypeSchema.options.join(", ")}.`);
    }
    return this.kyc.upload(
      tenant,
      customerId,
      parsed.data,
      { buffer: file.buffer, mimetype: file.mimetype, size: file.size },
      { staffUserId: user.id, bookingId: bookingId?.trim() || null },
    );
  }

  /** "Minta kekurangan via WhatsApp" — message the customer with only what is still missing. */
  @Post("customers/:customerId/request-missing")
  @UseGuards(CapabilityGuard)
  @RequireCapability("upload_kyc_on_behalf", "approve_booking")
  requestMissing(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("customerId") customerId: string,
    @Body("bookingId") bookingId: string | undefined,
  ) {
    return this.kyc.requestMissing(tenant, customerId, user.id, bookingId?.trim() || null);
  }

  /** "Verifikasi sekarang" — an approver verifies everything on file in one step. */
  @Post("customers/:customerId/verify")
  @UseGuards(CapabilityGuard)
  @RequireCapability("approve_booking", "approve_deposit_refund")
  verifyNow(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("customerId") customerId: string) {
    return this.kyc.verifyCustomerNow(tenant, customerId, user.id);
  }

  /* ---------------- PRD go-live 2 §5.2 — requests (batches) ---------------- */

  /** `?tab=review` (default: undecided) or `?tab=history` (verified and rejected). */
  @Get("requests")
  @UseGuards(CapabilityGuard)
  @RequireCapability("approve_booking", "approve_deposit_refund")
  listRequests(@CurrentTenantId() tenantId: string, @Query("tab") tab?: string) {
    return this.kyc.listRequests(tenantId, tab === "history" ? "history" : "review");
  }

  /** Verify the whole batch, or reject it with a reason that is sent to the customer. */
  @Post("requests/:id/decide")
  @UseGuards(CapabilityGuard)
  @RequireCapability("approve_booking", "approve_deposit_refund")
  decideRequest(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(DecideKycRequestSchema)) body: ReturnType<typeof DecideKycRequestSchema.parse>,
  ) {
    return this.kyc.decideRequest(tenant, id, user.id, body.decision, body.reason);
  }

  /** PRD §7.2.1: KYC verification is manual by an ops/finance reviewer in v1. */
  @Post("documents/:id/review")
  @UseGuards(CapabilityGuard)
  @RequireCapability("approve_booking", "approve_deposit_refund")
  review(
    @CurrentTenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ReviewKycDocumentRequestSchema)) body: ReturnType<typeof ReviewKycDocumentRequestSchema.parse>,
  ) {
    return this.kyc.review(tenantId, user.id, id, body.status, body.reason);
  }
}
