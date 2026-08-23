"use client";

import { useEffect } from "react";
import L from "leaflet";
import { MapContainer, Marker, Popup, TileLayer, useMap } from "react-leaflet";
import type { LocationDto } from "@rentos/contracts";

import "leaflet/dist/leaflet.css";

interface Props {
  locations: LocationDto[];
  userPosition: { lat: number; lng: number } | null;
  highlightId: string | null;
}

/** Inline SVG pins — Leaflet's default PNG icons don't resolve under a bundler without extra config. */
function pin(color: string): L.DivIcon {
  return L.divIcon({
    className: "",
    html: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="38" viewBox="0 0 28 38"><path d="M14 0C6.3 0 0 6.3 0 14c0 10.5 14 24 14 24s14-13.5 14-24C28 6.3 21.7 0 14 0z" fill="${color}"/><circle cx="14" cy="14" r="6" fill="#fff"/></svg>`,
    iconSize: [28, 38],
    iconAnchor: [14, 38],
    popupAnchor: [0, -34],
  });
}

const userDot = L.divIcon({
  className: "",
  html: `<div style="width:16px;height:16px;border-radius:9999px;background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 2px rgba(37,99,235,.35)"></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

function FitBounds({ points }: { points: Array<[number, number]> }) {
  const map = useMap();
  useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) {
      map.setView(points[0]!, 13);
      return;
    }
    map.fitBounds(L.latLngBounds(points), { padding: [32, 32], maxZoom: 13 });
  }, [map, points]);
  return null;
}

export default function LeafletMap({ locations, userPosition, highlightId }: Props) {
  const placed = locations.filter((l) => l.latitude !== null && l.longitude !== null);
  const points: Array<[number, number]> = placed.map((l) => [l.latitude!, l.longitude!]);
  if (userPosition) points.push([userPosition.lat, userPosition.lng]);
  const center: [number, number] = points[0] ?? [-6.2, 106.8]; // Jakarta

  return (
    <MapContainer center={center} zoom={11} scrollWheelZoom={false} className="h-72 w-full rounded-xl border border-brand-600/10" style={{ zIndex: 0 }}>
      <TileLayer attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" />
      <FitBounds points={points} />
      {placed.map((l) => (
        <Marker key={l.id} position={[l.latitude!, l.longitude!]} icon={pin(l.id === highlightId ? "#f59e0b" : "#0f172a")}>
          <Popup>
            <strong>{l.name}</strong>
            {l.address ? <br /> : null}
            {l.address}
            <br />
            <a href={`/locations/${l.id}`}>Choose this branch →</a>
          </Popup>
        </Marker>
      ))}
      {userPosition && <Marker position={[userPosition.lat, userPosition.lng]} icon={userDot} />}
    </MapContainer>
  );
}
