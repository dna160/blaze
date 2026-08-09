// BUILD-SPEC C5 — waitlist queue rules (pure). The single-fire ROW LOCK and the
// actual contract/invoice generation are DB/service concerns (they need
// SELECT ... FOR UPDATE on the asset); this module holds only the pure decisions:
// which entry fires next, how positions resequence, and whether a fired entry's
// payment TTL has lapsed.

export type WaitlistStatus = "ARMED" | "FIRED" | "EXPIRED" | "CONVERTED" | "CANCELLED";

export interface WaitlistEntryLike {
  id: string;
  position: number;
  status: WaitlistStatus;
  firedAt?: Date | null;
  expiresAt?: Date | null;
}

/**
 * The next entry to fire when a unit is released: the ARMED entry with the
 * lowest position. Returns null if the queue has no armed entries. The service
 * must take a row lock on the released asset BEFORE calling this and firing, so
 * two concurrent releases cannot both fire an entry for the same unit
 * (double-booking with a signed contract — the incident C5 rule 2 prevents).
 */
export function nextArmedEntry<T extends WaitlistEntryLike>(entries: readonly T[]): T | null {
  const armed = entries.filter((e) => e.status === "ARMED").sort((a, b) => a.position - b.position);
  return armed[0] ?? null;
}

/**
 * Recompute contiguous 1..n positions for the still-active (ARMED) entries after
 * one leaves the queue (fired/cancelled/converted). Returns id → new position for
 * entries whose position changed. Order is preserved.
 */
export function resequencePositions(entries: readonly WaitlistEntryLike[]): Map<string, number> {
  const armed = entries.filter((e) => e.status === "ARMED").sort((a, b) => a.position - b.position);
  const changes = new Map<string, number>();
  armed.forEach((e, idx) => {
    const next = idx + 1;
    if (e.position !== next) changes.set(e.id, next);
  });
  return changes;
}

/** Compute the payment-TTL expiry for a just-fired entry. */
export function computeFireExpiry(firedAt: Date, ttlHours: number): Date {
  return new Date(firedAt.getTime() + ttlHours * 60 * 60 * 1000);
}

/**
 * Has a FIRED entry's payment TTL lapsed? When true the service voids the fired
 * invoice, marks the entry EXPIRED, and fires the next armed entry (C5 rule 3 —
 * without this one non-paying waitlister freezes a unit indefinitely).
 */
export function isFireExpired(entry: WaitlistEntryLike, now: Date): boolean {
  return entry.status === "FIRED" && entry.expiresAt != null && now.getTime() > entry.expiresAt.getTime();
}
