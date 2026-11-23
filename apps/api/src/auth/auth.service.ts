import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { compare, hash } from "bcryptjs";
import { PASSWORD_POLICY_MESSAGES, passwordPolicyError } from "@rentos/contracts";
import { exchangeCustomerAccessToken } from "@rentos/database";

import { AuditService } from "../audit/audit.service.js";
import { BCRYPT_COST, passwordChangeMoment } from "../common/password-change.js";
import { RedisService } from "../common/redis/redis.service.js";
import type { AuthenticatedUser } from "../common/types/express-request.js";
import { CrmService } from "../crm/crm.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { PrismaService } from "../prisma/prisma.service.js";
import type { ResolvedTenant } from "../tenancy/tenancy.service.js";

/**
 * Sign-in links live 15 minutes, not the 30 days a message link gets. A link in
 * a booking confirmation is meant to be reusable from that message for the life
 * of the rental; a link that grants a session on demand is a credential, and the
 * blast radius of a forwarded one should be minutes.
 */
const LOGIN_LINK_TTL_DAYS = 15 / (24 * 60);

/** One sign-in link per number per minute. An unauthenticated endpoint that sends WhatsApp messages costs real money to abuse. */
const LOGIN_LINK_COOLDOWN_SECONDS = 60;

/** PRD go-live 2 §6.1 — wrong guesses at the current password on change-password, per account. */
const PASSWORD_CHANGE_MAX_FAILURES = 5;
const PASSWORD_CHANGE_FAILURE_WINDOW_SECONDS = 15 * 60;

/** The console's languages (PRD go-live 2 §9.1); anything else reads as Indonesian. */
function normalizeLocale(value: string | null | undefined): "id" | "en" {
  return value === "en" ? "en" : "id";
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
    private readonly audit: AuditService,
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

    // A login always succeeds for a correct password — but while the account
    // must change it (PRD go-live 2 §6.1), the session this returns can do
    // nothing else: `mustChangePassword` rides on the response for the console
    // to route on, and JwtAuthGuard enforces it server-side on every request.
    return this.issueStaffSession(user, { tenantId: tenant.id, organizationId: tenant.organizationId });
  }

  /**
   * One place a staff token is minted (login, and the fresh one after a
   * password change).
   *
   * BUILD-SPEC C2 — it carries the full role × scope assignments so the
   * CapabilityGuard can authorize per-tenant without a DB round-trip.
   *
   * `iat` is set explicitly: never earlier than the account's
   * `passwordChangedAt`, which JwtStrategy compares against to revoke the
   * sessions that predate a password change. `passwordChangedAt` is stored one
   * second ahead of the change (see `passwordChangeMoment`), so a login in the
   * same second as the change still gets a token that survives it.
   */
  private async issueStaffSession(
    user: {
      id: string;
      email: string;
      displayName: string | null;
      mustChangePassword: boolean;
      passwordChangedAt: Date | null;
      locale?: string | null;
      roles: Array<{ role: string; scope: string; tenantIds: string[] }>;
    },
    session: { tenantId: string | null; organizationId: string | null },
  ) {
    const now = Math.floor(Date.now() / 1000);
    const iat = Math.max(now, user.passwordChangedAt ? Math.floor(user.passwordChangedAt.getTime() / 1000) : 0);
    const roles = user.roles.map((r) => r.role);
    // The vendor platform admin (no tenant) holds no in-tenant assignments.
    const roleAssignments = session.tenantId ? user.roles.map((r) => ({ role: r.role, scope: r.scope, tenantIds: r.tenantIds })) : [];
    const accessToken = await this.jwt.signAsync({
      sub: user.id,
      tenantId: session.tenantId,
      ...(session.tenantId ? { organizationId: session.organizationId } : {}),
      kind: "STAFF",
      roles,
      roleAssignments,
      iat,
    });
    return {
      accessToken,
      user: {
        id: user.id,
        ...(session.tenantId ? { tenantId: session.tenantId, organizationId: session.organizationId } : {}),
        email: user.email,
        displayName: user.displayName,
        roles,
        ...(session.tenantId ? { roleAssignments } : {}),
        mustChangePassword: user.mustChangePassword,
        locale: normalizeLocale(user.locale),
      },
    };
  }

  /** The staff account behind a session, read in the context its tenancy calls for. */
  private loadStaffAccount(actor: { id: string; tenantId: string | null }) {
    return actor.tenantId
      ? this.prisma.runInTenantContext(actor.tenantId, (tx) => tx.user.findUnique({ where: { id: actor.id }, include: { roles: true } }))
      : this.prisma.runInPlatformContext((tx) => tx.user.findFirst({ where: { id: actor.id, tenantId: null }, include: { roles: true } }));
  }

  /** Who am I, as the account stands now — the console re-reads this to know whether a password change is still pending. */
  async staffMe(actor: AuthenticatedUser) {
    const user = await this.loadStaffAccount(actor);
    if (!user) throw new UnauthorizedException("This account is no longer active. Sign in again.");
    const roles = user.roles.map((r) => r.role);
    return {
      user: {
        id: user.id,
        tenantId: actor.tenantId,
        organizationId: actor.organizationId,
        email: user.email,
        displayName: user.displayName,
        roles,
        roleAssignments: actor.tenantId ? user.roles.map((r) => ({ role: r.role, scope: r.scope, tenantIds: r.tenantIds })) : [],
        mustChangePassword: user.mustChangePassword,
        locale: normalizeLocale(user.locale),
      },
    };
  }

  /** PRD go-live 2 §9.1 — the console language this staff member reads (`id` default, `en`). */
  async updateStaffPreferences(actor: AuthenticatedUser, prefs: { locale?: "id" | "en"; displayName?: string }) {
    const where = { id: actor.id };
    const data = {
      ...(prefs.locale !== undefined ? { locale: prefs.locale } : {}),
      ...(prefs.displayName !== undefined ? { displayName: prefs.displayName } : {}),
    };
    if (actor.tenantId) {
      await this.prisma.runInTenantContext(actor.tenantId, (tx) => tx.user.update({ where, data }));
    } else {
      await this.prisma.runInPlatformContext((tx) => tx.user.update({ where, data }));
    }
    return this.staffMe(actor);
  }

  /**
   * PRD go-live 2 §6.1 — change my own password.
   *
   * Needs the current password (a session left open on a shared desk must not
   * be enough to take the account over), applies the one password policy, and
   * then: clears `mustChangePassword`, revokes every other session of this
   * account (JwtStrategy refuses tokens issued before `passwordChangedAt`),
   * kills any set-password link still outstanding, and hands THIS session a
   * fresh token so the person who just changed it stays signed in.
   *
   * Wrong guesses at the current password are counted per account: after
   * five in fifteen minutes the endpoint answers 429 until the window passes.
   */
  async changeStaffPassword(actor: AuthenticatedUser, currentPassword: string, newPassword: string) {
    const failKey = `staff-password-change-fail:${actor.id}`;
    const failures = Number((await this.redis.client.get(failKey)) ?? 0);
    if (failures >= PASSWORD_CHANGE_MAX_FAILURES) {
      throw new HttpException(
        { code: "TOO_MANY_ATTEMPTS", message: "Terlalu banyak percobaan. Coba lagi dalam 15 menit. / Too many attempts. Try again in 15 minutes." },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.loadStaffAccount(actor);
    if (!user || !user.passwordHash || user.status !== "ACTIVE") {
      throw new UnauthorizedException("This account is no longer active. Sign in again.");
    }
    if (!(await compare(currentPassword, user.passwordHash))) {
      await this.redis.client.multi().incr(failKey).expire(failKey, PASSWORD_CHANGE_FAILURE_WINDOW_SECONDS).exec();
      // 400, not 401: the session is fine, the form is wrong — a 401 would sign the console out.
      throw new BadRequestException({ code: "CURRENT_PASSWORD_WRONG", message: "Kata sandi saat ini salah. / The current password is wrong." });
    }

    const problem = passwordPolicyError(newPassword, { email: user.email, displayName: user.displayName });
    if (problem) throw new BadRequestException({ code: "PASSWORD_POLICY", message: problem });
    if (await compare(newPassword, user.passwordHash)) {
      const m = PASSWORD_POLICY_MESSAGES.SAME_AS_CURRENT;
      throw new BadRequestException({ code: "PASSWORD_POLICY", message: `${m.id} / ${m.en}` });
    }

    const passwordHash = await hash(newPassword, BCRYPT_COST);
    const passwordChangedAt = passwordChangeMoment();
    const data = { passwordHash, mustChangePassword: false, passwordChangedAt };
    const updated = actor.tenantId
      ? await this.prisma.runInTenantContext(actor.tenantId, (tx) => tx.user.update({ where: { id: user.id }, data, include: { roles: true } }))
      : await this.prisma.runInPlatformContext((tx) => tx.user.update({ where: { id: user.id }, data, include: { roles: true } }));
    await this.prisma.raw.userPasswordToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: new Date() } });
    await this.redis.client.del(failKey);
    if (actor.tenantId) {
      await this.audit.record({
        tenantId: actor.tenantId,
        actorUserId: user.id,
        action: "STAFF_PASSWORD_CHANGED",
        entityType: "User",
        entityId: user.id,
        metadata: { forced: user.mustChangePassword },
      });
    }
    return this.issueStaffSession(updated, { tenantId: actor.tenantId, organizationId: actor.organizationId });
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
    return this.issueStaffSession(user, { tenantId: null, organizationId: null });
  }

  /**
   * Passwordless sign-in by magic link (PRD v2 §9) — now the only path. Meta
   * gates AUTHENTICATION-category templates separately and refuses to create
   * one on this account, so a passcode cannot be delivered at all; the OTP
   * endpoints were removed rather than left to fail. A link is also simply
   * better: the customer taps once instead of copying a code between two apps.
   *
   * Deliberately says nothing about whether the number is known. The caller
   * always sees the same answer, so this cannot be used to discover who rents
   * from this branch — which an unauthenticated endpoint keyed on phone number
   * otherwise would be.
   */
  async requestMagicLink(tenant: ResolvedTenant, phone: string): Promise<void> {
    // Checked before the cooldown and before the number is looked up, so the
    // answer is identical for a registered and an unregistered number. Doing it
    // after the lookup would make a 503 mean "this number rents here" and turn
    // the endpoint into exactly the enumeration oracle the uniform response
    // exists to prevent — the failure would be honest and the privacy gone.
    //
    // This is the one case where the customer is told something went wrong,
    // because a sign-in link that cannot be delivered is a sign-in that cannot
    // happen. Leaving them on a "check WhatsApp" screen for a message Meta
    // already refused is the behaviour this replaces.
    if (await this.notifications.isChannelDegraded(tenant.id)) {
      throw new ServiceUnavailableException(
        "Sign-in by WhatsApp is temporarily unavailable. Please try again in a few minutes, " +
          "or use a sign-in link from one of our earlier messages.",
      );
    }

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

}
