import ngeohash from 'ngeohash';
import type { FactRequest, FactResponse } from '../../shared/types';
import { GEOHASH_PRECISION, scaleForZoom } from '../../shared/geo';
import { offlineFact } from './offline';

// Set VITE_API_BASE when the web app is served from a different origin than the API
// (e.g. inside a Capacitor native shell: VITE_API_BASE=https://globe-facts.example.com).
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';

const memo = new Map<string, FactResponse>();

function key(r: FactRequest) {
  const scale = scaleForZoom(r.zoom);
  return `${ngeohash.encode(r.lat, r.lon, GEOHASH_PRECISION[scale])}:${scale}`;
}

export async function fetchFact(req: FactRequest, signal?: AbortSignal): Promise<FactResponse> {
  const k = key(req);
  const hit = memo.get(k);
  if (hit) return { ...hit, cached: true };

  const timeout = AbortSignal.timeout(20000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const res = await fetch(`${API_BASE}/api/fact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: combined,
    });
    if (!res.ok) throw new Error(`API ${res.status}`);
    const fact = (await res.json()) as FactResponse;
    memo.set(k, fact);
    if (memo.size > 300) memo.delete(memo.keys().next().value!);
    return fact;
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn('[globe-facts] API unavailable, using offline fact', err);
    return offlineFact(req.lat, req.lon, req.zoom);
  }
}
