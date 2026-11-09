// Orchestrates one tap: cache -> gather data -> Claude (or computed) -> validate -> log.

import { randomUUID } from 'node:crypto';
import ngeohash from 'ngeohash';
import type { FactRequest, FactResponse } from '../../shared/types';
import { GEOHASH_PRECISION, formatCoord, scaleForZoom } from '../../shared/geo';
import { config } from '../config';
import { TtlCache } from './cache';
import { gather, sourcesFor, type PlaceData } from './gather';
import { bestComputed } from './computed';
import { composeWithClaude, promptData } from './compose';
import { logFact } from './factLog';

const HOUR = 3600_000;
const factCache = new TtlCache<FactResponse>(config.cacheMaxEntries, 24 * HOUR);
const inflight = new Map<string, Promise<FactResponse>>();

export function cacheKey(req: FactRequest): string {
  const scale = scaleForZoom(req.zoom);
  return `${ngeohash.encode(req.lat, req.lon, GEOHASH_PRECISION[scale])}:${scale}:${req.epoch ?? 'now'}`;
}

export async function getFact(req: FactRequest): Promise<FactResponse> {
  const key = cacheKey(req);
  const hit = factCache.get(key);
  if (hit) return { ...hit, cached: true };
  // Collapse concurrent identical taps into one upstream call.
  const pending = inflight.get(key);
  if (pending) return { ...(await pending), cached: true };
  const p = buildFact(req, key).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function placeLabel(d: PlaceData): string {
  if (d.surface === 'ocean') return d.ocean?.name ?? 'Open ocean';
  const a = d.place;
  if (a?.displayName) {
    const parts = a.displayName.split(',').map((s) => s.trim());
    // Keep it short: first part + country (e.g. "Westminster, United Kingdom").
    return parts.length > 1 ? `${parts[0]}, ${parts[parts.length - 1]}` : parts[0];
  }
  return d.country ?? formatCoord(d.point.lat, d.point.lon);
}

async function buildFact(req: FactRequest, key: string): Promise<FactResponse> {
  const t0 = Date.now();
  const scale = scaleForZoom(req.zoom);
  const data = await gather(req.lat, req.lon, scale);
  const tGather = Date.now() - t0;

  const computed = bestComputed(data);
  let composed = null;
  let claudeError: string | undefined;
  try {
    composed = await composeWithClaude(data);
  } catch (err) {
    claudeError = (err as Error).message;
    console.warn(`[claude] ${claudeError}; using computed fact`);
  }

  const usedKeys = composed ? composed.used : computed.keys;
  const volatile = composed
    ? usedKeys.some((k) => k === 'sun' || k === 'weather')
    : !!computed.volatile;

  const res: FactResponse = {
    id: randomUUID(),
    lat: req.lat,
    lon: req.lon,
    scale,
    place: placeLabel(data),
    fact: composed?.fact ?? computed.fact,
    question: composed?.question ?? computed.question,
    sources: sourcesFor(data, usedKeys.length ? usedKeys : undefined),
    writer: composed ? 'claude' : 'computed',
    cached: false,
    data: process.env.NODE_ENV === 'production' && !process.env.EXPOSE_FACT_DATA ? undefined : promptData(data),
  };

  // Don't cache long when the fact depends on "now", or when we fell back because Claude failed.
  const ttl = volatile ? HOUR / 2 : claudeError ? 10 * 60_000 : 24 * HOUR;
  factCache.set(key, res, ttl);

  logFact({
    at: new Date().toISOString(),
    id: res.id,
    key,
    request: req,
    writer: res.writer,
    model: composed?.model,
    usage: composed?.usage,
    claudeError,
    fact: res.fact,
    question: res.question,
    used: usedKeys,
    ms: { gather: tGather, total: Date.now() - t0 },
    data: promptData(data),
  });
  return res;
}
