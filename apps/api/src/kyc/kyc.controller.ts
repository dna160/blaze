import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiTags } from "@nestjs/swagger";
import { ReviewKycDocumentRequestSchema } from "@rentos/contracts";
import type { Response } from "express";

import { CurrentTenantId } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { Roles } from "../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../common/guards/roles.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";

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
    @CurrentTenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body("documentType") documentType: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    if (user.kind !== "CUSTOMER") throw new ForbiddenException("Customer session required.");
    if (!file) throw new BadRequestException("No file uploaded.");
    if (documentType !== "KTP" && documentType !== "SELFIE") {
      throw new BadRequestException('documentType must be "KTP" or "SELFIE".');
    }
    return this.kyc.upload(tenantId, user.id, documentType, {
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
  @UseGuards(RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN", "VIEWER")
  listForReview(@CurrentTenantId() tenantId: string, @Query("status") status?: string) {
    return this.kyc.listForReview(tenantId, { status });
  }

  @Get("documents/:id/file")
  @UseGuards(RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN")
  async getFile(@CurrentTenantId() tenantId: string, @Param("id") id: string, @Res() res: Response) {
    const result = await this.kyc.getFile(tenantId, id);
    if (result.kind === "redirect") {
      res.redirect(result.url);
      return;
    }
    res.setHeader("Content-Type", result.contentType);
    res.send(result.buffer);
  }

  /** PRD §7.2.1: KYC verification is manual by an ops/finance reviewer in v1. */
  @Post("documents/:id/review")
  @UseGuards(RolesGuard)
  @Roles("SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN")
  review(
    @CurrentTenantId() tenantId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(ReviewKycDocumentRequestSchema)) body: ReturnType<typeof ReviewKycDocumentRequestSchema.parse>,
  ) {
    return this.kyc.review(tenantId, user.id, id, body.status, body.reason);
  }
}
