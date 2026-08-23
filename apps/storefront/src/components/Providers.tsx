"use client";

import { ClerkProvider } from "@clerk/clerk-react";
import type { ReactNode } from "react";

const CLERK_KEY = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

/**
 * PRD v2 D3/§9 — Google sign-in via Clerk, purely client-side
 * (@clerk/clerk-react, no Next middleware, no server helpers). The whole
 * thing is invisible unless NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is set at
 * build time: without it the tree renders exactly as before v2.
 */
export function Providers({ children }: { children: ReactNode }) {
  if (!CLERK_KEY) return <>{children}</>;
  return <ClerkProvider publishableKey={CLERK_KEY}>{children}</ClerkProvider>;
}

export const clerkEnabled = Boolean(CLERK_KEY);
