import { SetMetadata } from "@nestjs/common";
import type { Capability } from "@rentos/domain";

export const CAPABILITY_KEY = "required_capabilities";

/**
 * BUILD-SPEC C2 — gate a route on one or more capabilities (ANY-of semantics: a
 * user needs at least one). The CapabilityGuard resolves the caller's role ×
 * scope assignments and checks `can()` against the request's active tenant, so a
 * tenant-scoped role at branch A is denied a route serving branch B. Replaces
 * the old @Roles(...) flat-role decorator.
 */
export const RequireCapability = (...capabilities: Capability[]) =>
  SetMetadata(CAPABILITY_KEY, capabilities);
