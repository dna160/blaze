import { Body, Controller, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { ConsoleLoginRequestSchema, OtpRequestSchema, OtpVerifySchema } from "@rentos/contracts";

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
}
