import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { compare } from "bcryptjs";
import { randomInt } from "node:crypto";

import { RedisService } from "../common/redis/redis.service.js";
import { CrmService } from "../crm/crm.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

const OTP_TTL_SECONDS = 5 * 60;

@Injectable()
export class AuthService {
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

    const roles = user.roles.map((r) => r.role);
    const accessToken = await this.jwt.signAsync({ sub: user.id, tenantId: tenant.id, kind: "STAFF", roles });
    return {
      accessToken,
      user: { id: user.id, tenantId: tenant.id, email: user.email, displayName: user.displayName, roles },
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
    const key = this.otpKey(tenant.id, phone);
    const stored = await this.redis.client.get(key);
    if (!stored || stored !== code) {
      throw new UnauthorizedException("Invalid or expired code.");
    }
    await this.redis.client.del(key);

    const customer = await this.crm.getOrCreateByPhone(tenant.id, phone);
    const accessToken = await this.jwt.signAsync({
      sub: customer.id,
      tenantId: tenant.id,
      kind: "CUSTOMER",
      roles: ["CUSTOMER"],
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
