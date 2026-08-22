
/**
 * Magic-link URL (PRD v2 §9): `{storefrontBase}/m/{token}?next=/portal/...`.
 * The storefront's /m/[token] page exchanges the token for a session and
 * redirects to `next`. Pure string assembly, shared by apps/api and
 * apps/worker so both mint identical links.
 */
export function buildMagicLinkUrl(storefrontBaseUrl: string, token: string, next: string): string {
  const base = storefrontBaseUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({ next });
  return `${base}/m/${encodeURIComponent(token)}?${params.toString()}`;
}
