// Gathers structured, source-attributed data for a tapped point.
// Priority: 1) a story about this exact/nearby spot, 2) computed facts, 3) place name.
// Every source is optional and time-boxed; computed facts never need the network.

import type { Scale, SourceRef } from '../../shared/types';
import { antipode, compass, formatCoord, kmFromEquator, sunInfo, type SunInfo } from '../../shared/geo';
import { config } from '../config';
import { countryAt, isLand, nearestCoast, nearestCountry, roughOceanName } from '../sources/land';
import {
  elevation,
  geology,
  oceanDepth,
  reverseGeocode,
  seaName,
  weatherNow,
  wikidataNearest,
  wikiNearby,
  wikiSummary,
  type ElevationInfo,
  type GeologyInfo,
  type PlaceInfo,
  type WeatherNow,
  type WikiArticle,
} from '../sources/remote';

export interface PlaceData {
  point: { lat: number; lon: number; label: string; hemisphere: string; kmFromEquator: number };
  scale: Scale;
  surface: 'land' | 'ocean';
  country: string | null;
  place?: { name: string | null; displayName: string; level: string; population?: string };
  /** Notable things right here (nearest first), from Wikipedia geosearch. */
  nearby?: (WikiArticle & { direction?: string })[];
  /** Nearest well-known thing when nothing is close (from Wikidata). */
  nearestNotable?: WikiArticle & { direction?: string };
  /** The article for the area at this zoom (country / region / city / ocean). */
  area?: WikiArticle;
  elevation?: ElevationInfo;
  ocean?: { name: string; nameIsApproximate: boolean; depthMeters?: number; depthFeet?: number };
  coast?: {
    km: number;
    direction: string;
    nearestCoastCountry: string | null;
    approximateToKm: number;
    note: string;
  };
  geology?: GeologyInfo;
  antipode?: { lat: number; lon: number; label: string; surface: 'land' | 'ocean'; country: string | null; ocean?: string };
  sun?: SunInfo & { note: string };
  weather?: WeatherNow;
}

const GEOSEARCH_RADII: Partial<Record<Scale, number[]>> = {
  local: [250, 1000, 4000, 10000],
  city: [3000, 10000],
};

function withTimeout<T>(p: Promise<T | null>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]).catch(() => null);
}

function enTitle(tag?: string): string | null {
  if (!tag) return null;
  const m = /^en:(.+)$/.exec(tag);
  return m ? m[1] : null;
}

function areaTitle(scale: Scale, place: PlaceInfo | null, country: string | null): string | null {
  const a = place?.address ?? {};
  if (scale === 'planet' || scale === 'country') return a.country ?? country;
  if (scale === 'region') return enTitle(place?.wikipedia) ?? a.state ?? a.region ?? a.province ?? a.country ?? country;
  if (scale === 'city')
    return enTitle(place?.wikipedia) ?? a.city ?? a.town ?? a.village ?? a.county ?? a.state ?? null;
  return null;
}

export async function gather(lat: number, lon: number, scale: Scale): Promise<PlaceData> {
  const budget = config.gatherBudgetMs;
  const land = isLand(lat, lon);
  const offlineCountry = land ? countryAt(lat, lon) : null;

  // ---- computed (always available, instant)
  const anti = antipode(lat, lon);
  const antiLand = isLand(anti.lat, anti.lon);
  const coast = nearestCoast(lat, lon);
  const sun = sunInfo(lat, lon);

  const data: PlaceData = {
    point: {
      lat: Math.round(lat * 1e5) / 1e5,
      lon: Math.round(lon * 1e5) / 1e5,
      label: formatCoord(lat, lon),
      hemisphere: `${lat >= 0 ? 'Northern' : 'Southern'} and ${lon >= 0 ? 'Eastern' : 'Western'}`,
      kmFromEquator: Math.round(kmFromEquator(lat)),
    },
    scale,
    surface: land ? 'land' : 'ocean',
    country: offlineCountry,
    coast: {
      km: Math.round(coast.km),
      direction: compass(coast.bearingDeg),
      nearestCoastCountry: coast.country,
      approximateToKm: coast.resolutionKm,
      note: 'distance to the nearest coastline of a sizable landmass (Natural Earth 1:50m); small islands may be closer',
    },
    antipode: {
      lat: Math.round(anti.lat * 100) / 100,
      lon: Math.round(anti.lon * 100) / 100,
      label: formatCoord(anti.lat, anti.lon),
      surface: antiLand ? 'land' : 'ocean',
      country: antiLand ? countryAt(anti.lat, anti.lon) : null,
      ocean: antiLand ? undefined : roughOceanName(anti.lat, anti.lon),
    },
    sun: {
      ...sun,
      note: 'solarTime is mean local solar time from longitude, not clock time; computed at computedAtUtc',
    },
  };
  if (!land) data.country = null;

  // ---- network sources, in parallel, each time-boxed
  const placeP = withTimeout(reverseGeocode(lat, lon, scale), budget);
  const geoP = withTimeout(geology(lat, lon, scale), budget);
  const weatherP = withTimeout(weatherNow(lat, lon), Math.min(3500, budget));
  const elevP = land ? withTimeout(elevation(lat, lon), Math.min(3500, budget)) : Promise.resolve(null);
  const depthP = land ? Promise.resolve(null) : withTimeout(oceanDepth(lat, lon), Math.min(4500, budget));
  const seaP = land ? Promise.resolve(null) : withTimeout(seaName(lat, lon), Math.min(4500, budget));

  const radii = GEOSEARCH_RADII[scale];
  const nearbyP = land && radii ? withTimeout(wikiNearby(lat, lon, radii), budget) : Promise.resolve(null);

  const areaP = (async () => {
    if (!land) return null;
    const place = await placeP;
    const title = areaTitle(scale, place, offlineCountry);
    return title ? withTimeout(wikiSummary(title), 3500) : null;
  })();

  const notableP = (async () => {
    if (scale === 'planet' || scale === 'country') return null;
    const nearby = await nearbyP;
    if (nearby && nearby.length) return null;
    // Sparse places (deserts, ice, open sea): look further out for anything well-known.
    return (
      (await withTimeout(wikidataNearest(lat, lon, 60), 5000)) ??
      (await withTimeout(wikidataNearest(lat, lon, 300, 15), 5000))
    );
  })();

  const [place, geo, weather, elev, depth, sea, nearby, area, notable] = await Promise.all([
    placeP, geoP, weatherP, elevP, depthP, seaP, nearbyP, areaP, notableP,
  ]);

  if (place) {
    data.place = { name: place.name, displayName: place.displayName, level: place.level, population: place.population };
    if (land && place.address.country) data.country = place.address.country;
  }
  if (geo) data.geology = geo;
  if (weather) data.weather = weather;
  if (elev) data.elevation = elev;
  if (nearby?.length) data.nearby = nearby.map((a) => ({ ...a, direction: dir(a.bearingDeg) }));
  if (notable) data.nearestNotable = { ...notable, direction: dir(notable.bearingDeg) };

  if (!land) {
    const name = sea ?? roughOceanName(lat, lon);
    data.ocean = {
      name,
      nameIsApproximate: !sea,
      depthMeters: depth && depth.meters < 0 ? -depth.meters : undefined,
      depthFeet: depth && depth.meters < 0 ? Math.round(-depth.meters * 3.28084) : undefined,
    };
    // Ocean article (e.g. "Pacific Ocean") for planet/country scale taps on water.
    const oceanTitle = name.replace(/^(North|South) /, '');
    if (scale === 'planet' || scale === 'country') {
      const art = await withTimeout(wikiSummary(oceanTitle), 3000);
      if (art) data.area = art;
    }
    if (!data.coast?.nearestCoastCountry) data.coast!.nearestCoastCountry = nearestCountry(lat, lon, 3000);
  } else if (area) {
    data.area = area;
  }

  return data;
}

function dir(b?: number) {
  return b === undefined ? undefined : compass(b);
}

/**
 * Source references for whatever ended up in the data.
 * `keys` are top-level PlaceData keys; "nearby.N" selects one nearby article.
 */
export function sourcesFor(data: PlaceData, keys?: string[]): SourceRef[] {
  const out: SourceRef[] = [];
  const want = (k: string) => !keys || keys.some((x) => x === k || x.startsWith(`${k}.`));
  data.nearby?.forEach((a, i) => {
    const k = `nearby.${i}`;
    if (!keys ? i === 0 : keys.includes(k) || (keys.includes('nearby') && i === 0))
      out.push({ key: k, label: `Wikipedia: ${a.title}`, url: a.url });
  });
  const add = (key: string, label: string, url?: string) => {
    if (want(key)) out.push({ key, label, url });
  };
  if (data.nearestNotable) add('nearestNotable', `Wikipedia: ${data.nearestNotable.title}`, data.nearestNotable.url);
  if (data.area) add('area', `Wikipedia: ${data.area.title}`, data.area.url);
  if (data.geology) add('geology', 'Macrostrat geologic map', data.geology.url);
  if (data.elevation) add('elevation', 'Open-Meteo elevation (Copernicus DEM)', 'https://open-meteo.com/en/docs/elevation-api');
  if (data.ocean)
    add('ocean', data.ocean.depthMeters ? 'GEBCO bathymetry' : 'Marine Regions', data.ocean.depthMeters ? 'https://www.gebco.net/' : 'https://www.marineregions.org/');
  if (data.coast) add('coast', 'Natural Earth coastline (computed)', 'https://www.naturalearthdata.com/');
  if (data.antipode) add('antipode', 'Antipode (computed from Natural Earth)');
  if (data.sun) add('sun', 'Solar position (computed)');
  if (data.weather) add('weather', 'Open-Meteo current weather', 'https://open-meteo.com/');
  if (data.place) add('place', 'OpenStreetMap / Nominatim', 'https://www.openstreetmap.org/copyright');
  if (data.point) add('point', 'Coordinates (computed)');
  return out;
}
