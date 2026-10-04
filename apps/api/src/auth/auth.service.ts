import { Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
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

/**
 * Sign-in links live 15 minutes, not the 30 days a message link gets. A link in
 * a booking confirmation is meant to be reusable from that message for the life
 * of the rental; a link that grants a session on demand is a credential, and the
 * blast radius of a forwarded one should be minutes.
 */
const LOGIN_LINK_TTL_DAYS = 15 / (24 * 60);

/** One sign-in link per number per minute. An unauthenticated endpoint that sends WhatsApp messages costs real money to abuse. */
const LOGIN_LINK_COOLDOWN_SECONDS = 60;

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

interface CustomerLike {
  id: string;
  phone: string | null;
  email: string | null;
  fullName: string | null;
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

    // No role check: since BUILD-SPEC C2, `tenantId === null` IS the vendor
    // platform admin (BaseRole describes what someone may do inside a tenant,
    // which is what this user is outside of), and the lookup above already
    // filters on it. PlatformAdminGuard admits exactly this session shape.
    const roles = user.roles.map((r) => r.role);
    const accessToken = await this.jwt.signAsync({ sub: user.id, tenantId: null, kind: "STAFF", roles, roleAssignments: [] });
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

  /**
   * Passwordless sign-in by magic link (PRD v2 §9), the primary path now that
   * Meta gates AUTHENTICATION-category templates separately and `otp_code`
   * cannot be created on a new WABA. A link is also simply better: the customer
   * taps once instead of copying a code between two apps.
   *
   * Deliberately says nothing about whether the number is known. The caller
   * always sees the same answer, so this cannot be used to discover who rents
   * from this branch — which an unauthenticated endpoint keyed on phone number
   * otherwise would be.
   */
  async requestMagicLink(tenant: ResolvedTenant, phone: string): Promise<void> {
    const cooldownKey = `login-link:${tenant.id}:${phone}`;
    const fresh = await this.redis.client.set(cooldownKey, "1", "EX", LOGIN_LINK_COOLDOWN_SECONDS, "NX");
    if (!fresh) {
      // Already sent one in the last minute. Silently done, for the same reason
      // the response never varies: a rate-limit message is itself a signal.
      this.logger.log(`Sign-in link for ${phone} suppressed by cooldown.`);
      return;
    }

    // Looked up, never created. The OTP path only calls getOrCreateByPhone after
    // the code is verified — i.e. after control of the number is proven — and
    // this endpoint is unauthenticated, so creating here would let anyone fill
    // the customer table by posting phone numbers at it. An unknown number is
    // silently a no-op; accounts come from booking.
    const customer = await this.crm.findByPhone(tenant.id, phone);
    if (!customer) {
      this.logger.log(`Sign-in link requested for an unknown number on ${tenant.slug}; nothing sent.`);
      return;
    }
    if (customer.isBlocklisted) {
      this.logger.warn(`Sign-in link requested for blocklisted customer ${customer.id}.`);
      return;
    }

    const link = await this.notifications.mintMagicLink(
      tenant.id,
      tenant.slug,
      customer.id,
      "LOGIN",
      "/portal",
      LOGIN_LINK_TTL_DAYS,
    );

    // Sent to the number that asked, on WhatsApp, rather than through
    // notifyCustomer's preferred-channel routing: someone signing in by phone
    // expects the link on that phone, not in an inbox they may not have open.
    await this.notifications.notify({
      tenantId: tenant.id,
      customerId: customer.id,
      channel: "WHATSAPP",
      templateKey: "login_link",
      recipient: phone,
      variables: { customerName: customer.fullName ?? "Pelanggan", link },
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
      organizationId: tenant.organizationId,
      kind: "CUSTOMER",
      roles: ["CUSTOMER"],
      roleAssignments: [],
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
