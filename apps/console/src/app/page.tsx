"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { authClient } from "@/lib/auth-client";

export default function IndexPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace(authClient.getToken() ? "/bookings" : "/login");
  }, [router]);
  return null;
}
