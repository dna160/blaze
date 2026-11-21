-- PRD go-live 2 §6.1 — force a password change on every staff account that
-- exists today.
--
-- Until now an admin typed a new colleague's password into the console (and on
-- 2026-11-17 several were created live with simple passwords said out loud).
-- From this release an account only ever gets a single-use set-password link,
-- so every password that predates it is treated as known to someone else: the
-- next login goes to the change-password page, and the API refuses everything
-- else for that session until the password has been changed.
--
-- Not touched:
--  - accounts with no password yet (they are still waiting on their link);
--  - the vendor's platform admin (tenant_id IS NULL), which no tenant admin
--    ever created or typed a password for.
--
-- The demo seed (dev / demo databases only) sets its own accounts back to
-- "no change needed" so local flows keep working; a production database is
-- never seeded with users, so there every pre-existing account stays forced.
UPDATE "users"
   SET "must_change_password" = true
 WHERE "password_hash" IS NOT NULL
   AND "tenant_id" IS NOT NULL;
