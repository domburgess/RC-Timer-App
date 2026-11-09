// Small fetch wrapper: timeouts, a polite User-Agent, JSON parsing, and a
// per-host serial queue for APIs with strict rate limits (e.g. Nominatim: 1 req/s).

import { config } from './config';

export class HttpError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export interface FetchOpts {
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOpts = {}): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      body: opts.body,
      signal: ctrl.signal,
      headers: {
        'User-Agent': config.userAgent,
        Accept: 'application/json',
        ...opts.headers,
      },
    });
    if (!res.ok) throw new HttpError(`${res.status} from ${new URL(url).host}`, res.status);
    return (await res.json()) as T;
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new HttpError(`timeout from ${new URL(url).host}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Serialises calls and keeps at least `minGapMs` between their starts. */
export function rateLimited(minGapMs: number) {
  let chain: Promise<unknown> = Promise.resolve();
  let last = 0;
  return function run<T>(fn: () => Promise<T>, maxWaitMs = 4000): Promise<T> {
    const queuedAt = Date.now();
    const next = chain.then(async () => {
      const wait = Math.max(0, last + minGapMs - Date.now());
      if (Date.now() + wait - queuedAt > maxWaitMs) throw new HttpError('rate-limit queue too long');
      if (wait) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    chain = next.catch(() => undefined);
    return next;
  };
}
