// Offline land / ocean / country / coastline lookups using Natural Earth 1:50m data
// (bundled via the `world-atlas` package). Always available: no network needed.
// Resolution is ~5 km, so coastline distances are reported as approximate.

import { createRequire } from 'node:module';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import { bearingDeg, haversineKm, normalizeLon } from '../../shared/geo';

type Ring = Float64Array; // [lon0, lat0, lon1, lat1, ...]
interface Poly {
  rings: Ring[];
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
}
interface Country {
  name: string;
  polys: Poly[];
}

const require = createRequire(import.meta.url);

function toPolys(geom: GeoJSON.Geometry | null): Poly[] {
  if (!geom) return [];
  const list =
    geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  return list.map((rawRings) => {
    // Some Natural Earth polygons (Antarctica) carry a degenerate ring along the pole
    // before the real coastline; drop rings with no latitude extent.
    const rings = rawRings.filter((r) => Math.max(...r.map((p) => p[1])) - Math.min(...r.map((p) => p[1])) > 1e-3);
    let minLon = 180,
      maxLon = -180,
      minLat = 90,
      maxLat = -90;
    const out = rings.map((ring) => {
      const arr = new Float64Array(ring.length * 2);
      ring.forEach(([lon, lat], i) => {
        arr[i * 2] = lon;
        arr[i * 2 + 1] = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      });
      return arr;
    });
    return { rings: out.length ? out : [new Float64Array(0)], minLon, maxLon, minLat, maxLat };
  });
}

// Natural Earth abbreviates many names ("Dem. Rep. Congo"); spell them out for prose.
const FULL_NAMES: Record<string, string> = {
  'Marshall Is.': 'Marshall Islands',
  'N. Mariana Is.': 'Northern Mariana Islands',
  'U.S. Virgin Is.': 'U.S. Virgin Islands',
  'S. Geo. and the Is.': 'South Georgia and the South Sandwich Islands',
  'Br. Indian Ocean Ter.': 'British Indian Ocean Territory',
  'Pitcairn Is.': 'Pitcairn Islands',
  'Falkland Is.': 'Falkland Islands',
  'Cayman Is.': 'Cayman Islands',
  'British Virgin Is.': 'British Virgin Islands',
  'Turks and Caicos Is.': 'Turks and Caicos Islands',
  'S. Sudan': 'South Sudan',
  'Solomon Is.': 'Solomon Islands',
  'St. Vin. and Gren.': 'Saint Vincent and the Grenadines',
  'St. Kitts and Nevis': 'Saint Kitts and Nevis',
  'Cook Is.': 'Cook Islands',
  'W. Sahara': 'Western Sahara',
  'St. Pierre and Miquelon': 'Saint Pierre and Miquelon',
  'Wallis and Futuna Is.': 'Wallis and Futuna',
  'Fr. Polynesia': 'French Polynesia',
  'Fr. S. Antarctic Lands': 'French Southern and Antarctic Lands',
  'Eq. Guinea': 'Equatorial Guinea',
  'Dominican Rep.': 'Dominican Republic',
  'Faeroe Is.': 'Faroe Islands',
  'N. Cyprus': 'Northern Cyprus',
  'Dem. Rep. Congo': 'Democratic Republic of the Congo',
  'Central African Rep.': 'Central African Republic',
  'Bosnia and Herz.': 'Bosnia and Herzegovina',
  'Indian Ocean Ter.': 'Australian Indian Ocean Territories',
  'Heard I. and McDonald Is.': 'Heard Island and McDonald Islands',
  'Ashmore and Cartier Is.': 'Ashmore and Cartier Islands',
  'Antigua and Barb.': 'Antigua and Barbuda',
  'United States of America': 'United States',
};

let land: Poly[] | null = null;
let countries: Country[] | null = null;

function load() {
  if (land && countries) return;
  const landTopo = require('world-atlas/land-50m.json') as Topology<{ land: GeometryCollection }>;
  const fc = feature(landTopo, landTopo.objects.land) as GeoJSON.FeatureCollection;
  land = fc.features.flatMap((f) => toPolys(f.geometry));

  const cTopo = require('world-atlas/countries-50m.json') as Topology<{ countries: GeometryCollection }>;
  const cfc = feature(cTopo, cTopo.objects.countries) as GeoJSON.FeatureCollection;
  countries = cfc.features.map((f) => ({
    name: ((n: string) => FULL_NAMES[n] ?? n)(String((f.properties as { name?: string })?.name ?? 'Unknown')),
    polys: toPolys(f.geometry),
  }));
}

function ringContains(r: Ring, lon: number, lat: number): boolean {
  let inside = false;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[i * 2],
      yi = r[i * 2 + 1],
      xj = r[j * 2],
      yj = r[j * 2 + 1];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polyContains(p: Poly, lon: number, lat: number): boolean {
  if (lon < p.minLon || lon > p.maxLon || lat < p.minLat || lat > p.maxLat) return false;
  if (!ringContains(p.rings[0], lon, lat)) return false;
  for (let i = 1; i < p.rings.length; i++) if (ringContains(p.rings[i], lon, lat)) return false;
  return true;
}

export function isLand(lat: number, lon: number): boolean {
  load();
  lon = normalizeLon(lon);
  // Antarctica's polygon runs along the -90 parallel; treat the far south as land.
  if (lat < -85) return true;
  return land!.some((p) => polyContains(p, lon, lat));
}

export function countryAt(lat: number, lon: number): string | null {
  load();
  lon = normalizeLon(lon);
  if (lat < -85) return 'Antarctica';
  for (const c of countries!) if (c.polys.some((p) => polyContains(p, lon, lat))) return c.name;
  return null;
}

interface Nearest {
  km: number;
  lat: number;
  lon: number;
}

/** Nearest point on any of the given polygons' rings. Uses a local projection per segment. */
function nearestOnPolys(polys: Poly[], lat: number, lon: number): Nearest {
  const cosLat = Math.cos((lat * Math.PI) / 180) || 1e-6;
  let best = Infinity;
  let bx = 0,
    by = 0;
  for (const p of polys) {
    for (const r of p.rings) {
      const n = r.length / 2;
      for (let i = 0; i < n - 1; i++) {
        // Project to a local plane centred on the query point (degrees, x scaled by cos(lat)).
        let ax = r[i * 2] - lon;
        let bxs = r[i * 2 + 2] - lon;
        if (ax > 180) ax -= 360;
        else if (ax < -180) ax += 360;
        if (bxs > 180) bxs -= 360;
        else if (bxs < -180) bxs += 360;
        if (Math.abs(ax - bxs) > 180) continue; // segment crossing the antimeridian cut
        ax *= cosLat;
        bxs *= cosLat;
        const ay = r[i * 2 + 1] - lat;
        const bys = r[i * 2 + 3] - lat;
        const dx = bxs - ax,
          dy = bys - ay;
        const len2 = dx * dx + dy * dy;
        let t = len2 ? -(ax * dx + ay * dy) / len2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = ax + t * dx,
          py = ay + t * dy;
        const d = px * px + py * py;
        if (d < best) {
          best = d;
          bx = px / cosLat + lon;
          by = py + lat;
        }
      }
    }
  }
  const nlat = by,
    nlon = normalizeLon(bx);
  return { km: haversineKm(lat, lon, nlat, nlon), lat: nlat, lon: nlon };
}

export interface CoastInfo {
  km: number;
  /** Compass bearing from the tapped point toward the nearest coast. */
  bearingDeg: number;
  /** Country whose coast is nearest (if the coast belongs to one). */
  country: string | null;
  resolutionKm: number;
}

export function nearestCoast(lat: number, lon: number): CoastInfo {
  load();
  const n = nearestOnPolys(land!, lat, lon);
  return {
    km: n.km,
    bearingDeg: bearingDeg(lat, lon, n.lat, n.lon),
    country: nearestCountry(n.lat, n.lon, 30),
    resolutionKm: 5,
  };
}

/** Closest country to a point (useful in the ocean). Returns null if none within maxKm. */
export function nearestCountry(lat: number, lon: number, maxKm = Infinity): string | null {
  load();
  const inside = countryAt(lat, lon);
  if (inside) return inside;
  let best: { name: string; km: number } | null = null;
  for (const c of countries!) {
    const n = nearestOnPolys(c.polys, lat, lon);
    if (!best || n.km < best.km) best = { name: c.name, km: n.km };
  }
  return best && best.km <= maxKm ? best.name : null;
}

/**
 * Very coarse ocean / sea label used only when no gazetteer answer is available.
 * Flagged as approximate in the data sent to the model.
 */
export function roughOceanName(lat: number, lon: number): string {
  lon = normalizeLon(lon);
  if (lat > 66) return 'Arctic Ocean';
  if (lat < -60) return 'Southern Ocean';
  if (lat > 30 && lat < 46 && lon > -5.5 && lon < 36) return 'Mediterranean Sea';
  if (lat > 10 && lat < 30 && lon > 32 && lon < 44) return 'Red Sea';
  if (lat > 0 && lat < 25 && lon > 50 && lon < 78) return 'Arabian Sea';
  if (lat > 5 && lat < 23 && lon > 80 && lon < 95) return 'Bay of Bengal';
  if (lat > 9 && lat < 22 && lon > -88 && lon < -60) return 'Caribbean Sea';
  if (lat > 18 && lat < 31 && lon > -98 && lon < -81) return 'Gulf of Mexico';
  const hemi = lat >= 0 ? 'North' : 'South';
  // Indian Ocean: south of Asia, between Africa and Australia.
  if (lat < 30 && lon >= 20 && lon < 147 && !(lat > -8 && lon > 100)) return 'Indian Ocean';
  // Pacific: east of Asia/Australia to the Americas (boundary tilts with latitude).
  const americasEdge = lat > 15 ? -100 : lat > 8 ? -84 : -70;
  if (lon >= 100 || lon < americasEdge) return `${hemi} Pacific Ocean`;
  return `${hemi} Atlantic Ocean`;
}
