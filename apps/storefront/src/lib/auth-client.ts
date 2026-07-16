"use client";

const TOKEN_KEY = "rentos_customer_token";

/** Client-side only — customer JWT storage. Simple by design: v1 has no refresh-token rotation (tracked in docs/HANDOFF.md). */
export const authClient = {
  getToken(): string | null {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(TOKEN_KEY);
  },
  setToken(token: string): void {
    window.localStorage.setItem(TOKEN_KEY, token);
  },
  clear(): void {
    window.localStorage.removeItem(TOKEN_KEY);
  },
};
