/**
 * PRD go-live 2 §6.1 — session revocation on a password change.
 *
 * Staff sessions are stateless JWTs, so "revoke the other sessions" is done by
 * comparison: `User.passwordChangedAt` is written whenever the password
 * changes (self-service change, the set-password link, an admin reset) and
 * JwtStrategy refuses any staff token issued before it.
 *
 * A JWT's `iat` is in whole seconds, so the moment is stored on a second
 * boundary, ONE SECOND AHEAD of now: every token that exists at the time of
 * the change has `iat <= now` and is therefore older than the moment, even one
 * issued in the same second. The session that made the change is re-issued
 * with `iat` equal to the moment (AuthService.issueStaffSession), and so is any
 * login that follows within that second.
 */
export function passwordChangeMoment(now: Date = new Date()): Date {
  return new Date((Math.floor(now.getTime() / 1000) + 1) * 1000);
}

export const BCRYPT_COST = 10;
