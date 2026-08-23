import { Body, Controller, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  ClerkExchangeSchema,
  ConsoleLoginRequestSchema,
  MagicLinkExchangeSchema,
  OtpRequestSchema,
  OtpVerifySchema,
  PlatformLoginRequestSchema,
} from "@rentos/contracts";

import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { AuthService } from "./auth.service.js";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("console/login")
  consoleLogin(
    @CurrentTenant() tenant: ResolvedTenant,
    @Body(new ZodValidationPipe(ConsoleLoginRequestSchema)) body: ReturnType<typeof ConsoleLoginRequestSchema.parse>,
  ) {
    return this.auth.consoleLogin(tenant, body.email, body.password);
  }

  /** Platform-admin login (Session 26) — tenant-agnostic, no @CurrentTenant() involved by design. */
  @Post("platform/login")
  platformLogin(
    @Body(new ZodValidationPipe(PlatformLoginRequestSchema)) body: ReturnType<typeof PlatformLoginRequestSchema.parse>,
  ) {
    return this.auth.platformLogin(body.email, body.password);
  }

  @Post("otp/request")
  async requestOtp(
    @CurrentTenant() tenant: ResolvedTenant,
    @Body(new ZodValidationPipe(OtpRequestSchema)) body: ReturnType<typeof OtpRequestSchema.parse>,
  ) {
    await this.auth.requestOtp(tenant, body.phone);
    return { status: "sent" };
  }

  @Post("otp/verify")
  verifyOtp(
    @CurrentTenant() tenant: ResolvedTenant,
    @Body(new ZodValidationPipe(OtpVerifySchema)) body: ReturnType<typeof OtpVerifySchema.parse>,
  ) {
    return this.auth.verifyOtp(tenant, body.phone, body.code);
  }

  /** PRD v2 §9 — magic link from a WhatsApp/email message -> customer session, no OTP. */
  @Post("magic/exchange")
  exchangeMagicLink(
    @CurrentTenant() tenant: ResolvedTenant,
    @Body(new ZodValidationPipe(MagicLinkExchangeSchema)) body: ReturnType<typeof MagicLinkExchangeSchema.parse>,
  ) {
    return this.auth.exchangeMagicLink(tenant, body.token);
  }

  /** PRD v2 D3 — Clerk (Google) session token -> customer session keyed by email. */
  @Post("clerk/exchange")
  exchangeClerk(
    @CurrentTenant() tenant: ResolvedTenant,
    @Body(new ZodValidationPipe(ClerkExchangeSchema)) body: ReturnType<typeof ClerkExchangeSchema.parse>,
  ) {
    return this.auth.exchangeClerkSession(tenant, body.token, body.phone);
  }
}
