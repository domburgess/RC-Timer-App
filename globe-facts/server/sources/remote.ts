// Network data sources. Every function returns null (never throws) when its source
// is unavailable, so the fact engine can always fall back to computed facts.

import { config } from '../config';
import { fetchJson, rateLimited } from '../http';
import { TtlCache } from '../engine/cache';
import { bearingDeg } from '../../shared/geo';
import type { Scale } from '../../shared/types';

const sourceCache = new TtlCache<unknown>(20000, 24 * 3600_000);
const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;

async function cached<T>(key: string, fn: () => Promise<T | null>): Promise<T | null> {
  const hit = sourceCache.get(key);
  if (hit !== undefined) return hit as T | null;
  try {
    const v = await fn();
    sourceCache.set(key, v);
    return v;
  } catch (err) {
    console.warn(`[source] ${key.split(':')[0]} failed: ${(err as Error).message}`);
    return null; // do not cache failures
  }
}

// ---------------------------------------------------------------- Nominatim
// Usage policy: max 1 request/second, identifying User-Agent, cache results.
// https://operations.osmfoundation.org/policies/nominatim/
const nominatimQueue = rateLimited(1100);

const NOMINATIM_ZOOM: Record<Scale, number> = { planet: 3, country: 3, region: 5, city: 10, local: 17 };

export interface PlaceInfo {
  name: string | null;
  displayName: string;
  /** Nominatim's addresstype, e.g. "country", "state", "city", "road", "building". */
  level: string;
  category?: string;
  type?: string;
  address: Record<string, string>;
  wikipedia?: string; // "en:Title"
  wikidata?: string;
  population?: string;
}

export function reverseGeocode(lat: number, lon: number, scale: Scale): Promise<PlaceInfo | null> {
  const z = NOMINATIM_ZOOM[scale];
  const key = `nominatim:${round(lat, scale === 'local' ? 4 : 2)},${round(lon, scale === 'local' ? 4 : 2)}:${z}`;
  return cached(key, async () => {
    const params = new URLSearchParams({
      lat: String(lat),
      lon: String(lon),
      zoom: String(z),
      format: 'jsonv2',
      addressdetails: '1',
      extratags: '1',
      'accept-language': 'en',
    });
    if (config.nominatimEmail) params.set('email', config.nominatimEmail);
    const r = await nominatimQueue(() =>
      fetchJson<Record<string, any>>(`${config.nominatimUrl}/reverse?${params}`, { timeoutMs: 4000 }),
    );
    if (!r || r.error) return null; // open ocean -> "Unable to geocode"
    const extra = (r.extratags ?? {}) as Record<string, string>;
    return {
      name: r.name || null,
      displayName: String(r.display_name ?? ''),
      level: String(r.addresstype ?? r.type ?? 'unknown'),
      category: r.category,
      type: r.type,
      address: (r.address ?? {}) as Record<string, string>,
      wikipedia: extra.wikipedia,
      wikidata: extra.wikidata,
      population: extra.population,
    };
  });
}

// ---------------------------------------------------------------- Wikipedia
const WIKI = 'https://en.wikipedia.org';

export interface WikiArticle {
  title: string;
  description?: string;
  extract: string;
  url: string;
  distanceKm?: number;
  bearingDeg?: number;
}

/** Notable articles near a point. Tries progressively wider radii (metres, max 10 000). */
export function wikiNearby(lat: number, lon: number, radii: number[]): Promise<WikiArticle[] | null> {
  const key = `wikigeo:${round(lat, 4)},${round(lon, 4)}:${radii.join('/')}`;
  return cached(key, async () => {
    for (const radius of radii) {
      const params = new URLSearchParams({
        action: 'query',
        list: 'geosearch',
        gscoord: `${lat}|${lon}`,
        gsradius: String(Math.min(10000, radius)),
        gslimit: '8',
        gsnamespace: '0',
        format: 'json',
        formatversion: '2',
        origin: '*',
      });
      const r = await fetchJson<any>(`${WIKI}/w/api.php?${params}`, { timeoutMs: 3500 });
      const hits: any[] = r?.query?.geosearch ?? [];
      if (!hits.length) continue;
      const details = await wikiExtracts(hits.slice(0, 4).map((h) => h.pageid));
      return hits
        .slice(0, 4)
        .map((h): WikiArticle | null => {
          const d = details.get(h.pageid);
          if (!d || !d.extract) return null;
          return {
            ...d,
            distanceKm: round(h.dist / 1000, 3),
            bearingDeg: Math.round(bearingDeg(lat, lon, h.lat, h.lon)),
          };
        })
        .filter((a): a is WikiArticle => !!a);
    }
    return [];
  });
}

async function wikiExtracts(pageIds: number[]): Promise<Map<number, WikiArticle>> {
  const params = new URLSearchParams({
    action: 'query',
    prop: 'extracts|description|info',
    inprop: 'url',
    exintro: '1',
    explaintext: '1',
    exsentences: '4',
    pageids: pageIds.join('|'),
    format: 'json',
    formatversion: '2',
    origin: '*',
  });
  const r = await fetchJson<any>(`${WIKI}/w/api.php?${params}`, { timeoutMs: 3500 });
  const out = new Map<number, WikiArticle>();
  for (const p of r?.query?.pages ?? []) {
    out.set(p.pageid, {
      title: p.title,
      description: p.description,
      extract: String(p.extract ?? '').trim(),
      url: p.fullurl ?? `${WIKI}/?curid=${p.pageid}`,
    });
  }
  return out;
}

/** Summary of a named article (used for country / region / city scale). */
export function wikiSummary(title: string): Promise<WikiArticle | null> {
  return cached(`wikisum:${title}`, async () => {
    const r = await fetchJson<any>(`${WIKI}/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, {
      timeoutMs: 3500,
    });
    if (!r?.extract || r.type === 'disambiguation') return null;
    return {
      title: r.title,
      description: r.description,
      extract: r.extract,
      url: r.content_urls?.desktop?.page ?? `${WIKI}/wiki/${encodeURIComponent(r.title)}`,
    };
  });
}

// ---------------------------------------------------------------- Wikidata
/** Nearest well-known Wikidata item (>= `minSitelinks` language editions) within radiusKm. */
export function wikidataNearest(
  lat: number,
  lon: number,
  radiusKm: number,
  minSitelinks = 8,
): Promise<(WikiArticle & { qid: string }) | null> {
  const key = `wikidata:${round(lat, 2)},${round(lon, 2)}:${radiusKm}`;
  return cached(key, async () => {
    const sparql = `
SELECT ?item ?itemLabel ?dist ?coord ?article WHERE {
  SERVICE wikibase:around {
    ?item wdt:P625 ?coord .
    bd:serviceParam wikibase:center "Point(${lon} ${lat})"^^geo:wktLiteral .
    bd:serviceParam wikibase:radius "${radiusKm}" .
    bd:serviceParam wikibase:distance ?dist .
  }
  ?item wikibase:sitelinks ?links . FILTER(?links >= ${minSitelinks})
  ?article schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY ?dist LIMIT 1`;
    const r = await fetchJson<any>(
      `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`,
      { timeoutMs: 5000, headers: { Accept: 'application/sparql-results+json' } },
    );
    const b = r?.results?.bindings?.[0];
    if (!b) return null;
    const m = /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(b.coord?.value ?? '');
    const title = decodeURIComponent(String(b.article.value).split('/wiki/')[1] ?? '').replace(/_/g, ' ');
    const summary = title ? await wikiSummary(title) : null;
    return {
      qid: String(b.item.value).split('/').pop()!,
      title: summary?.title ?? b.itemLabel?.value,
      description: summary?.description,
      extract: summary?.extract ?? '',
      url: b.article.value,
      distanceKm: round(Number(b.dist.value), 1),
      bearingDeg: m ? Math.round(bearingDeg(lat, lon, Number(m[2]), Number(m[1]))) : undefined,
    };
  });
}

// ---------------------------------------------------------------- Open-Meteo
export interface ElevationInfo {
  meters: number;
  feet: number;
}

export function elevation(lat: number, lon: number): Promise<ElevationInfo | null> {
  return cached(`elev:${round(lat, 3)},${round(lon, 3)}`, async () => {
    const r = await fetchJson<any>(
      `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`,
      { timeoutMs: 3000 },
    );
    const m = r?.elevation?.[0];
    if (typeof m !== 'number' || Number.isNaN(m)) return null;
    return { meters: Math.round(m), feet: Math.round(m * 3.28084) };
  });
}

export interface WeatherNow {
  temperatureC: number;
  timezone: string;
  utcOffsetSeconds: number;
  localTime: string; // ISO local time from Open-Meteo
}

export async function weatherNow(lat: number, lon: number): Promise<WeatherNow | null> {
  // Short-lived: weather changes. Keyed by ~10 km and the current hour.
  const hour = new Date().toISOString().slice(0, 13);
  return cached(`wx:${round(lat, 1)},${round(lon, 1)}:${hour}`, async () => {
    const r = await fetchJson<any>(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m&timezone=auto`,
      { timeoutMs: 3000 },
    );
    if (typeof r?.current?.temperature_2m !== 'number') return null;
    return {
      temperatureC: r.current.temperature_2m,
      timezone: r.timezone,
      utcOffsetSeconds: r.utc_offset_seconds,
      localTime: r.current.time,
    };
  });
}

// ---------------------------------------------------------------- Ocean depth (GEBCO via OpenTopoData)
// Public instance limits: 1 request/second, 1000/day. Self-host or swap URL for production.
const topoQueue = rateLimited(1050);

export function oceanDepth(lat: number, lon: number): Promise<{ meters: number } | null> {
  return cached(`gebco:${round(lat, 2)},${round(lon, 2)}`, async () => {
    const r = await topoQueue(() =>
      fetchJson<any>(`https://api.opentopodata.org/v1/gebco2020?locations=${lat},${lon}`, { timeoutMs: 4000 }),
    );
    const e = r?.results?.[0]?.elevation;
    if (typeof e !== 'number') return null;
    return { meters: Math.round(e) }; // negative below sea level
  });
}

// ---------------------------------------------------------------- Marine Regions (IHO sea names)
export function seaName(lat: number, lon: number): Promise<string | null> {
  return cached(`mr:${round(lat, 1)},${round(lon, 1)}`, async () => {
    const r = await fetchJson<any[]>(
      `https://www.marineregions.org/rest/getGazetteerRecordsByLatLong.json/${lat}/${lon}/`,
      { timeoutMs: 4000 },
    );
    if (!Array.isArray(r)) return null;
    const pick =
      r.find((x) => /IHO Sea Area/i.test(x?.placeType ?? '')) ??
      r.find((x) => /^(Sea|Ocean|Gulf|Bay)$/i.test(x?.placeType ?? ''));
    return pick?.preferredGazetteerName ?? null;
  });
}

// ---------------------------------------------------------------- Macrostrat (geology)
export interface GeologyInfo {
  name: string;
  stratName?: string;
  lithology?: string;
  description?: string;
  /** Oldest / youngest age of the unit in millions of years. */
  oldestMa?: number;
  youngestMa?: number;
  oldestInterval?: string;
  youngestInterval?: string;
  ageText?: string;
  url: string;
}

const MACRO_SCALE: Record<Scale, string> = {
  planet: 'tiny',
  country: 'small',
  region: 'medium',
  city: 'large',
  local: 'large',
};

export function humanAge(ma: number): string {
  if (ma >= 1000) return `${round(ma / 1000, 1)} billion years`;
  if (ma >= 1) return `${ma >= 10 ? Math.round(ma) : round(ma, 1)} million years`;
  const years = Math.round(ma * 1e6);
  return years >= 1000 ? `${Math.round(years / 1000).toLocaleString('en-US')},000 years` : `${years} years`;
}

function ageRange(youngMa: number, oldMa: number): string {
  const y = humanAge(youngMa);
  const o = humanAge(oldMa);
  const unit = (s: string) => s.replace(/^[\d.,]+ /, '');
  if (unit(y) === unit(o)) return `between ${y.split(' ')[0]} and ${o} old`;
  return `between ${y} and ${o} old`;
}

export function geology(lat: number, lon: number, scale: Scale): Promise<GeologyInfo | null> {
  const s = MACRO_SCALE[scale];
  return cached(`macro:${round(lat, 3)},${round(lon, 3)}:${s}`, async () => {
    const r = await fetchJson<any>(
      `https://macrostrat.org/api/v2/geologic_units/map?lat=${lat}&lng=${lon}&scale=${s}`,
      { timeoutMs: 4500 },
    );
    const units: any[] = r?.success?.data ?? [];
    const u = units.find((x) => x && (x.name || x.strat_name)) ?? null;
    if (!u) return null;
    const oldest = typeof u.b_int_age === 'number' ? u.b_int_age : undefined;
    const youngest = typeof u.t_int_age === 'number' ? u.t_int_age : undefined;
    const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 400) : undefined);
    return {
      name: clean(u.name) ?? clean(u.strat_name) ?? 'unnamed unit',
      stratName: clean(u.strat_name),
      lithology: clean(u.lith),
      description: clean(u.descrip),
      oldestMa: oldest,
      youngestMa: youngest,
      oldestInterval: clean(u.b_int_name),
      youngestInterval: clean(u.t_int_name),
      ageText:
        oldest !== undefined
          ? youngest !== undefined && Math.abs(oldest - youngest) > 0.5
            ? ageRange(youngest, oldest)
            : `about ${humanAge(oldest)} old`
          : undefined,
      url: `https://macrostrat.org/map/#x=${lon}&y=${lat}&z=8`,
    };
  });
}

