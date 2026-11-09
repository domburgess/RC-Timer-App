// Fact built entirely on-device when the API is unreachable (offline / server down).
// Uses only pure computations, so it is always true.

import type { FactResponse } from '../../shared/types';
import { antipode, formatCoord, kmFromEquator, scaleForZoom, sunInfo } from '../../shared/geo';

export function offlineFact(lat: number, lon: number, zoom: number): FactResponse {
  const a = antipode(lat, lon);
  const sun = sunInfo(lat, lon);
  const options = [
    `The exact opposite side of the Earth from here is ${formatCoord(a.lat, a.lon)}. Dig straight down and that's where you'd surface.`,
    sun.elevationDeg > 0
      ? `Right now the sun is ${sun.elevationDeg}° above the horizon here, and it's about ${sun.solarTime} local solar time.`
      : `It's night here right now: the sun is ${Math.abs(sun.elevationDeg)}° below the horizon (about ${sun.solarTime} solar time).`,
    `This spot is ${Math.round(kmFromEquator(lat)).toLocaleString('en-US')} km ${lat >= 0 ? 'north' : 'south'} of the equator.`,
  ];
  const fact = options[Math.abs(Math.round(lat * 7 + lon * 3)) % options.length];
  return {
    id: `offline-${Date.now()}`,
    lat,
    lon,
    scale: scaleForZoom(zoom),
    place: formatCoord(lat, lon),
    fact,
    sources: [{ key: 'computed', label: 'Computed on your device (offline)' }],
    writer: 'offline',
    cached: false,
  };
}
