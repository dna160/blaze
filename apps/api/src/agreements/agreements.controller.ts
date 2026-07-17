import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { BookingService } from "../booking/booking.service.js";
import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { AgreementsService } from "./agreements.service.js";

const STAFF_ROLES = new Set(["SUPER_ADMIN", "OPS_ADMIN", "FINANCE_ADMIN"]);

@ApiTags("contracts")
@Controller("contracts")
@UseGuards(JwtAuthGuard)
export class AgreementsController {
  constructor(
    private readonly contracts: AgreementsService,
    private readonly booking: BookingService,
  ) {}

  @Get("by-booking/:bookingId")
  async getByBooking(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("bookingId") bookingId: string,
  ) {
    await this.assertAccess(tenant, user, bookingId);
    return this.contracts.getByBooking(tenant.id, bookingId);
  }

  @Get(":id/file")
  async getFile(@CurrentTenant() tenant: ResolvedTenant, @CurrentUser() user: AuthenticatedUser, @Param("id") id: string, @Res() res: Response) {
    const contract = await this.contracts.getById(tenant.id, id);
    await this.assertAccess(tenant, user, contract.bookingId);
    const result = await this.contracts.getFile(tenant.id, id);
    if (result.kind === "redirect") {
      res.redirect(result.url);
      return;
    }
    res.setHeader("Content-Type", result.contentType);
    res.send(result.buffer);
  }

  /** Either the customer (self-serve) or ops/finance staff (recording a paper contract) can upload the signed document. */
  @Post("by-booking/:bookingId/sign")
  @UseInterceptors(FileInterceptor("file"))
  async sign(
    @CurrentTenant() tenant: ResolvedTenant,
    @CurrentUser() user: AuthenticatedUser,
    @Param("bookingId") bookingId: string,
    @Body("signedByName") signedByName: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    await this.assertAccess(tenant, user, bookingId);
    if (!file) throw new BadRequestException("No file uploaded.");
    if (!signedByName) throw new BadRequestException("signedByName is required.");
    return this.contracts.sign(tenant, bookingId, signedByName, {
      buffer: file.buffer,
      mimetype: file.mimetype,
      size: file.size,
    });
  }

  private async assertAccess(tenant: ResolvedTenant, user: AuthenticatedUser, bookingId: string): Promise<void> {
    if (user.kind === "CUSTOMER") {
      const booking = await this.booking.getBooking(tenant.id, bookingId);
      if (booking.customerId !== user.id) throw new ForbiddenException("This booking does not belong to you.");
      return;
    }
    if (!user.roles.some((r) => STAFF_ROLES.has(r))) {
      throw new ForbiddenException();
    }
  }
}
