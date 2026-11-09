import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FactRequest } from '../shared/types';
import { config } from './config';
import { getFact } from './engine/factService';
import { claudeEnabled } from './engine/compose';
import { isEpochSupported } from './engine/timeTravel';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '4kb' }));

// --- very small per-IP rate limit (protects the Anthropic bill and upstream APIs)
const hits = new Map<string, { n: number; reset: number }>();
function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  const ip = req.ip ?? 'unknown';
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || h.reset < now) hits.set(ip, { n: 1, reset: now + 60_000 });
  else if (++h.n > config.rateLimitPerMin) {
    res.status(429).json({ error: 'Too many taps. Give the globe a second.' });
    return;
  }
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  next();
}

function parse(body: any): FactRequest | string {
  const lat = Number(body?.lat);
  const lon = Number(body?.lon);
  const zoom = Number(body?.zoom ?? 0);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return 'lat must be between -90 and 90';
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return 'lon must be between -180 and 180';
  if (!Number.isFinite(zoom) || zoom < 0 || zoom > 24) return 'zoom must be between 0 and 24';
  const mode = body?.mode === 'guess' ? 'guess' : 'fact';
  const epoch = body?.epoch ?? 'now';
  if (!isEpochSupported(epoch)) return `epoch "${epoch}" is not supported yet`;
  return { lat, lon, zoom, mode, epoch };
}

async function factHandler(req: express.Request, res: express.Response) {
  const parsed = parse(req.body);
  if (typeof parsed === 'string') {
    res.status(400).json({ error: parsed });
    return;
  }
  try {
    res.json(await getFact(parsed));
  } catch (err) {
    console.error('[fact] failed', err);
    res.status(500).json({ error: 'Could not build a fact for this spot.' });
  }
}

app.post('/fact', rateLimit, factHandler);
app.post('/api/fact', rateLimit, factHandler);
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, claude: claudeEnabled(), model: claudeEnabled() ? config.model : null });
});

// In production the same server hosts the built web app.
const dist = resolve(process.cwd(), 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1h', index: false }));
  app.get('*', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}

app.listen(config.port, () => {
  console.log(`Globe Facts API on http://localhost:${config.port}`);
  console.log(
    claudeEnabled()
      ? `Claude: ${config.model} (effort ${config.effort})`
      : 'Claude: OFF (no ANTHROPIC_API_KEY or USE_CLAUDE=0) - serving computed facts only',
  );
});
