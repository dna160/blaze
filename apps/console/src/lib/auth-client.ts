"use client";

const TOKEN_KEY = "rentos_staff_token";
const USER_KEY = "rentos_staff_user";

export interface StaffSessionUser {
  id: string;
  email: string;
  displayName: string | null;
  roles: string[];
}

export const authClient = {
  getToken(): string | null {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(TOKEN_KEY);
  },
  getUser(): StaffSessionUser | null {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as StaffSessionUser) : null;
  },
  setSession(token: string, user: StaffSessionUser): void {
    window.localStorage.setItem(TOKEN_KEY, token);
    window.localStorage.setItem(USER_KEY, JSON.stringify(user));
  },
  clear(): void {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(USER_KEY);
  },
};
