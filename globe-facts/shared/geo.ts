// Pure geo / astronomy helpers. No network, no dependencies: used by the server
// to compute facts, and by the client to produce an offline fallback fact.

import type { Scale } from './types';

const R_KM = 6371.0088;
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export function normalizeLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial bearing from point 1 to point 2, degrees clockwise from north. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
export function compass(bearing: number): string {
  return COMPASS[Math.round(bearing / 45) % 8];
}

export function antipode(lat: number, lon: number): { lat: number; lon: number } {
  return { lat: -lat, lon: normalizeLon(lon + 180) };
}

export function formatKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  if (km < 10) return `${km.toFixed(1)} km`;
  return `${Math.round(km).toLocaleString('en-US')} km`;
}

export function formatCoord(lat: number, lon: number): string {
  const la = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`;
  const lo = `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
  return `${la}, ${lo}`;
}

export interface SunInfo {
  /** Sun elevation above the horizon in degrees (negative = below). */
  elevationDeg: number;
  /** Mean local solar time as "HH:MM" (not civil/time-zone time). */
  solarTime: string;
  /** Where on Earth the sun is directly overhead right now. */
  subsolar: { lat: number; lon: number };
  isDay: boolean;
  computedAtUtc: string;
}

/** Low-precision solar position (accurate to ~0.1°, plenty for facts). */
export function sunInfo(lat: number, lon: number, when: Date = new Date()): SunInfo {
  const d = when.getTime() / 86400000 + 2440587.5 - 2451545.0; // days since J2000
  const g = toRad((357.529 + 0.98560028 * d) % 360);
  const q = (280.459 + 0.98564736 * d) % 360;
  const L = toRad(q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
  const e = toRad(23.439 - 0.00000036 * d);
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmstDeg = ((18.697374558 + 24.06570982441908 * d) * 15) % 360;
  const hourAngle = toRad(gmstDeg + lon) - ra;
  const elev = Math.asin(
    Math.sin(toRad(lat)) * Math.sin(dec) + Math.cos(toRad(lat)) * Math.cos(dec) * Math.cos(hourAngle),
  );
  const utcHours = when.getUTCHours() + when.getUTCMinutes() / 60;
  const solar = (((utcHours + lon / 15) % 24) + 24) % 24;
  const hh = Math.floor(solar);
  const mm = Math.floor((solar - hh) * 60);
  return {
    elevationDeg: Math.round(toDeg(elev) * 10) / 10,
    solarTime: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`,
    subsolar: {
      lat: Math.round(toDeg(dec) * 100) / 100,
      lon: Math.round(normalizeLon(toDeg(ra) - gmstDeg) * 100) / 100,
    },
    isDay: toDeg(elev) > -0.833,
    computedAtUtc: when.toISOString(),
  };
}

/** Map zoom (MapLibre, 0 = whole planet) to the scale a fact should be written at. */
export function scaleForZoom(zoom: number): Scale {
  if (zoom < 2.5) return 'planet';
  if (zoom < 5) return 'country';
  if (zoom < 8) return 'region';
  if (zoom < 12.5) return 'city';
  return 'local';
}

/** Geohash precision used for caching at each scale (cell size roughly matches scale). */
export const GEOHASH_PRECISION: Record<Scale, number> = {
  planet: 2, // ~630 km cells
  country: 3, // ~156 km
  region: 4, // ~39 km
  city: 5, // ~4.9 km
  local: 7, // ~150 m
};

/** Distance from the equator, along a meridian. */
export function kmFromEquator(lat: number): number {
  return (Math.abs(lat) * Math.PI * R_KM) / 180;
}
