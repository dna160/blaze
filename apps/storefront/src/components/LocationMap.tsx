"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import type { LocationDto } from "@rentos/contracts";

/**
 * Storefront step 1 (PRD v2 §4.1, D4): pick a branch. Leaflet +
 * OpenStreetMap tiles — no API key, no billing. If the browser shares its
 * position, branches are sorted by straight-line distance and the nearest
 * gets a "closest to you" badge; if not, the list is alphabetical and the
 * map simply frames every branch. Leaflet touches `window` at import time,
 * so the map itself is loaded client-side only.
 */
const LeafletMap = dynamic(() => import("./LeafletMap"), { ssr: false, loading: () => <div className="h-72 w-full animate-pulse rounded-xl bg-brand-700/5" /> });

interface Props {
  locations: LocationDto[];
  /** Storage-unit counts per branch for the list cards, keyed by location id. */
  unitCounts?: Record<string, number>;
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function LocationMap({ locations, unitCounts = {} }: Props) {
  const [position, setPosition] = useState<{ lat: number; lng: number } | null>(null);
  const [geoState, setGeoState] = useState<"idle" | "asking" | "granted" | "denied">("idle");

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    setGeoState("asking");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGeoState("granted");
      },
      () => setGeoState("denied"),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 },
    );
  }, []);

  const ranked = useMemo(() => {
    const withCoords = locations.map((l) => ({
      location: l,
      distanceKm: position && l.latitude !== null && l.longitude !== null ? haversineKm(position, { lat: l.latitude, lng: l.longitude }) : null,
    }));
    return withCoords.sort((a, b) => {
      if (a.distanceKm !== null && b.distanceKm !== null) return a.distanceKm - b.distanceKm;
      if (a.distanceKm !== null) return -1;
      if (b.distanceKm !== null) return 1;
      return a.location.name.localeCompare(b.location.name);
    });
  }, [locations, position]);

  const closestId = ranked[0]?.distanceKm !== null && ranked[0]?.distanceKm !== undefined ? ranked[0].location.id : null;

  return (
    <div className="grid gap-6 md:grid-cols-5">
      <div className="md:col-span-3">
        <LeafletMap locations={locations} userPosition={position} highlightId={closestId} />
        <p className="mt-2 text-xs text-brand-700/60">
          {geoState === "granted"
            ? "Sorted by distance from your location."
            : geoState === "denied"
              ? "Share your location to see the closest branch first."
              : "Finding the branch closest to you…"}
        </p>
      </div>
      <ol className="space-y-3 md:col-span-2">
        {ranked.map(({ location, distanceKm }, i) => (
          <li key={location.id}>
            <Link
              href={`/locations/${location.id}`}
              className={`block rounded-xl border bg-white p-4 transition hover:shadow-md ${
                location.id === closestId ? "border-accent-500 ring-1 ring-accent-500" : "border-brand-600/10"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{location.name}</p>
                  {location.address && <p className="mt-0.5 text-sm text-brand-700/60">{location.address}</p>}
                </div>
                {location.id === closestId && (
                  <span className="shrink-0 rounded-full bg-accent-500 px-2 py-0.5 text-xs font-semibold text-white">Closest to you</span>
                )}
              </div>
              <p className="mt-2 text-xs text-brand-700/60">
                {distanceKm !== null ? `${distanceKm < 10 ? distanceKm.toFixed(1) : Math.round(distanceKm)} km away` : `Branch ${i + 1}`}
                {unitCounts[location.id] !== undefined ? ` · ${unitCounts[location.id]} units` : ""}
              </p>
            </Link>
          </li>
        ))}
      </ol>
    </div>
  );
}
