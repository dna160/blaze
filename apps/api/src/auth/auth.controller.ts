import { Body, Controller, Get, HttpCode, Patch, Post, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import {
  UpdateStaffPreferencesRequestSchema,
  ChangeStaffPasswordRequestSchema,
  ClerkExchangeSchema,
  ConsoleLoginRequestSchema,
  SetStaffPasswordRequestSchema,
  MagicLinkExchangeSchema,
  MagicLinkRequestSchema,
  PlatformLoginRequestSchema,
} from "@rentos/contracts";

import { AllowPendingPasswordChange } from "../common/decorators/allow-pending-password-change.decorator.js";
import { CurrentTenant } from "../common/decorators/current-tenant.decorator.js";
import { CurrentUser } from "../common/decorators/current-user.decorator.js";
import { JwtAuthGuard } from "../common/guards/jwt-auth.guard.js";
import { StaffGuard } from "../common/guards/staff.guard.js";
import { ZodValidationPipe } from "../common/pipes/zod-validation.pipe.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

import { UsersService } from "../users/users.service.js";

import { AuthService } from "./auth.service.js";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  @Post("console/login")
  consoleLogin(
    @CurrentTenant() tenant: ResolvedTenant,
    @Body(new ZodValidationPipe(ConsoleLoginRequestSchema)) body: ReturnType<typeof ConsoleLoginRequestSchema.parse>,
  ) {
    return this.auth.consoleLogin(tenant, body.email, body.password);
  }

  /** PRD go-live §4.4 — a new staff member sets their password from the single-use link. Public by design. */
  @Post("staff/set-password")
  setStaffPassword(@Body(new ZodValidationPipe(SetStaffPasswordRequestSchema)) body: ReturnType<typeof SetStaffPasswordRequestSchema.parse>) {
    return this.users.setPasswordWithToken(body.token, body.password);
  }

  /**
   * PRD go-live 2 §6.1 — who this staff session is, as the account stands now.
   * Allowed while a password change is pending: the console reads it to decide
   * where to send the user.
   */
  @Get("staff/me")
  @UseGuards(JwtAuthGuard, StaffGuard)
  @AllowPendingPasswordChange()
  staffMe(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.staffMe(user);
  }

  /** PRD go-live 2 §9.1 — my console preferences (today: the language). */
  @Patch("staff/me")
  @UseGuards(JwtAuthGuard, StaffGuard)
  updateStaffMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(UpdateStaffPreferencesRequestSchema)) body: ReturnType<typeof UpdateStaffPreferencesRequestSchema.parse>,
  ) {
    return this.auth.updateStaffPreferences(user, body);
  }

  /**
   * PRD go-live 2 §6.1 — change my own password (current + new). The one
   * mutating route a session with a pending password change may call. Answers
   * with a fresh token: every other session of the account is revoked.
   */
  @Post("staff/change-password")
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, StaffGuard)
  @AllowPendingPasswordChange()
  changeStaffPassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(ChangeStaffPasswordRequestSchema)) body: ReturnType<typeof ChangeStaffPasswordRequestSchema.parse>,
  ) {
    return this.auth.changeStaffPassword(user, body.currentPassword, body.newPassword);
  }

  /** Platform-admin login (Session 26) — tenant-agnostic, no @CurrentTenant() involved by design. */
  @Post("platform/login")
  platformLogin(
    @Body(new ZodValidationPipe(PlatformLoginRequestSchema)) body: ReturnType<typeof PlatformLoginRequestSchema.parse>,
  ) {
    return this.auth.platformLogin(body.email, body.password);
  }

  /**
   * Ask for a sign-in link by phone. Always answers "sent", whether or not the
   * number is known — the alternative turns this into a way to find out who
   * rents from this branch.
   */
  @Post("magic/request")
  async requestMagicLink(
    @CurrentTenant() tenant: ResolvedTenant,
    @Body(new ZodValidationPipe(MagicLinkRequestSchema)) body: ReturnType<typeof MagicLinkRequestSchema.parse>,
  ) {
    await this.auth.requestMagicLink(tenant, body.phone);
    return { status: "sent" };
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
