import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { compare } from "bcryptjs";
import { randomInt } from "node:crypto";

import { RedisService } from "../common/redis/redis.service.js";
import { CrmService } from "../crm/crm.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

const OTP_TTL_SECONDS = 5 * 60;

/**
 * DEV-ONLY OTP bypass — for demos/testing before the WhatsApp Cloud API is live.
 * Returns the accepted bypass code only when BOTH are true: we are NOT in
 * production (`NODE_ENV !== "production"`) AND `DEV_OTP_BYPASS_CODE` is explicitly
 * set. Both gates must hold, so the bypass can never authenticate anyone in a
 * production build even if the env var leaks into it. Returns null when disabled.
 */
function devOtpBypassCode(): string | null {
  if (process.env.NODE_ENV === "production") return null;
  const code = process.env.DEV_OTP_BYPASS_CODE;
  return code && code.length > 0 ? code : null;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    private readonly crm: CrmService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Console (staff) login — email + password (PRD §7.2.7 users & roles). */
  async consoleLogin(tenant: ResolvedTenant, email: string, password: string) {
    const user = await this.prisma.runInTenantContext(tenant.id, (tx) =>
      tx.user.findUnique({ where: { tenantId_email: { tenantId: tenant.id, email } }, include: { roles: true } }),
    );
    if (!user || !user.passwordHash || user.status !== "ACTIVE") {
      throw new UnauthorizedException("Invalid credentials.");
    }
    const valid = await compare(password, user.passwordHash);
    if (!valid) throw new UnauthorizedException("Invalid credentials.");

    // BUILD-SPEC C2 — carry full role × scope assignments in the token so the
    // CapabilityGuard can authorize per-tenant without a DB round-trip.
    const roleAssignments = user.roles.map((r) => ({
      role: r.role,
      scope: r.scope,
      tenantIds: r.tenantIds,
    }));
    const roles = roleAssignments.map((r) => r.role);
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      tenantId: tenant.id,
      organizationId: tenant.organizationId,
      kind: "STAFF",
      roles,
      roleAssignments,
    });
    return {
      accessToken,
      user: {
        id: user.id,
        tenantId: tenant.id,
        organizationId: tenant.organizationId,
        email: user.email,
        displayName: user.displayName,
        roles,
        roleAssignments,
      },
    };
  }

  /** Customer OTP request — "phone number + WhatsApp OTP (primary)... No passwords in v1" (PRD §7.1.2). */
  async requestOtp(tenant: ResolvedTenant, phone: string): Promise<void> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await this.redis.client.set(this.otpKey(tenant.id, phone), code, "EX", OTP_TTL_SECONDS);
    await this.notifications.notify({
      tenantId: tenant.id,
      channel: "WHATSAPP",
      templateKey: "otp_code",
      recipient: phone,
      variables: { code },
    });
  }

  async verifyOtp(tenant: ResolvedTenant, phone: string, code: string) {
    const bypass = devOtpBypassCode();
    if (bypass && code === bypass) {
      // Dev/demo only — accept the fixed code without a real WhatsApp round-trip.
      // Cannot run in production (see devOtpBypassCode). Loud so it never hides.
      this.logger.warn(
        `DEV OTP BYPASS accepted for ${phone} on tenant ${tenant.slug} — disable by unsetting DEV_OTP_BYPASS_CODE / running with NODE_ENV=production.`,
      );
      // Clear any real pending code so a subsequent real login isn't confused.
      await this.redis.client.del(this.otpKey(tenant.id, phone));
    } else {
      const key = this.otpKey(tenant.id, phone);
      const stored = await this.redis.client.get(key);
      if (!stored || stored !== code) {
        throw new UnauthorizedException("Invalid or expired code.");
      }
      await this.redis.client.del(key);
    }

    const customer = await this.crm.getOrCreateByPhone(tenant.id, phone);
    const accessToken = await this.jwt.signAsync({
      sub: customer.id,
      tenantId: tenant.id,
      organizationId: tenant.organizationId,
      kind: "CUSTOMER",
      roles: ["CUSTOMER"],
      roleAssignments: [],
    });
    return {
      accessToken,
      customer: { id: customer.id, tenantId: tenant.id, phone: customer.phone, fullName: customer.fullName },
    };
  }

  private otpKey(tenantId: string, phone: string): string {
    return `otp:${tenantId}:${phone}`;
  }
}
