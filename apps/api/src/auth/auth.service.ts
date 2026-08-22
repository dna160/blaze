import { Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { compare } from "bcryptjs";
import { randomInt } from "node:crypto";
import { exchangeCustomerAccessToken } from "@rentos/database";

import { RedisService } from "../common/redis/redis.service.js";
import { CrmService } from "../crm/crm.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

const OTP_TTL_SECONDS = 5 * 60;

interface CustomerLike {
  id: string;
  phone: string | null;
  email: string | null;
  fullName: string | null;
}

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

  /**
   * Platform-admin login (Session 26, PRD Phase 4) — the tenant-agnostic
   * counterpart to consoleLogin. No `ResolvedTenant` involved: platform
   * admins have `User.tenantId === null` (see that field's doc comment),
   * so the lookup runs under `runInPlatformContext` instead of
   * `runInTenantContext`, and the issued JWT carries `tenantId: null` —
   * `JwtAuthGuard` already treats that as "skip the tenant-match check"
   * (it has since Session 16, this role just wasn't wired to any
   * controller until now).
   */
  async platformLogin(email: string, password: string) {
    const user = await this.prisma.runInPlatformContext((tx) =>
      tx.user.findFirst({ where: { tenantId: null, email }, include: { roles: true } }),
    );
    if (!user || !user.passwordHash || user.status !== "ACTIVE") {
      throw new UnauthorizedException("Invalid credentials.");
    }
    const valid = await compare(password, user.passwordHash);
    if (!valid) throw new UnauthorizedException("Invalid credentials.");

    const roles = user.roles.map((r) => r.role);
    if (!roles.includes("PLATFORM_ADMIN")) {
      throw new UnauthorizedException("Invalid credentials.");
    }

    const accessToken = await this.jwt.signAsync({ sub: user.id, tenantId: null, kind: "STAFF", roles });
    return {
      accessToken,
      user: { id: user.id, email: user.email, displayName: user.displayName, roles },
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
    return this.issueCustomerSession(tenant, customer);
  }

  /**
   * Magic link (PRD v2 §9): the token from a `/m/{token}` link in a
   * WhatsApp/email message. Looked up under the request's tenant RLS
   * context, so a token minted for tenant A can never resolve against
   * tenant B even if presented there.
   */
  async exchangeMagicLink(tenant: ResolvedTenant, token: string) {
    const exchanged = await this.prisma.runInTenantContext(tenant.id, (tx) => exchangeCustomerAccessToken(tx, token));
    if (!exchanged) throw new UnauthorizedException("This link is invalid or has expired. Request a new one from your latest message.");
    const customer = await this.crm.getById(tenant.id, exchanged.customerId);
    if (customer.isBlocklisted) throw new UnauthorizedException("This account cannot sign in.");
    return { ...(await this.issueCustomerSession(tenant, customer)), purpose: exchanged.purpose };
  }

  /**
   * Google sign-in via Clerk (PRD v2 D3/§9). Verifies the Clerk session JWT
   * the storefront obtained client-side, then reads the user's primary
   * email from Clerk (session tokens don't carry it by default) and
   * finds/creates the customer by email. `@clerk/backend` is loaded lazily
   * so a deployment without Clerk configured never touches it.
   */
  async exchangeClerkSession(tenant: ResolvedTenant, token: string, phone?: string) {
    const secretKey = process.env.CLERK_SECRET_KEY;
    if (!secretKey) {
      throw new ServiceUnavailableException("Google sign-in is not configured for this storefront (CLERK_SECRET_KEY is unset).");
    }
    const clerk = await import("@clerk/backend");
    let userId: string;
    try {
      const payload = await clerk.verifyToken(token, { secretKey });
      userId = payload.sub;
    } catch {
      throw new UnauthorizedException("Google sign-in could not be verified.");
    }
    const client = clerk.createClerkClient({ secretKey });
    const user = await client.users.getUser(userId);
    const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId) ?? user.emailAddresses[0];
    if (!primary?.emailAddress) throw new UnauthorizedException("Your Google account has no email address we can use.");
    const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ") || undefined;

    const customer = await this.crm.getOrCreateByClerkIdentity(tenant.id, {
      clerkUserId: userId,
      email: primary.emailAddress.toLowerCase(),
      fullName,
      phone,
    });
    return this.issueCustomerSession(tenant, customer);
  }

  private async issueCustomerSession(tenant: ResolvedTenant, customer: CustomerLike) {
    const accessToken = await this.jwt.signAsync({
      sub: customer.id,
      tenantId: tenant.id,
      kind: "CUSTOMER",
      roles: ["CUSTOMER"],
    });
    return {
      accessToken,
      customer: { id: customer.id, tenantId: tenant.id, phone: customer.phone, email: customer.email, fullName: customer.fullName },
    };
  }

  private otpKey(tenantId: string, phone: string): string {
    return `otp:${tenantId}:${phone}`;
  }
}
