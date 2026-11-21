import { SetMetadata } from "@nestjs/common";

export const ALLOW_PENDING_PASSWORD_CHANGE_KEY = "allow_pending_password_change";

/**
 * PRD go-live 2 §6.1 — a staff session whose account has `mustChangePassword`
 * set is refused by JwtAuthGuard on EVERY authenticated route (403, code
 * PASSWORD_CHANGE_REQUIRED) except the ones carrying this decorator: reading
 * who I am, and changing my password. Opt-in on purpose: a new route is locked
 * for such a session unless someone decides it should not be.
 */
export const AllowPendingPasswordChange = () => SetMetadata(ALLOW_PENDING_PASSWORD_CHANGE_KEY, true);
