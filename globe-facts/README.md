# Globe Facts (working title)

Open the app and you're looking at a spinning 3D Earth. Tap anywhere to get one short, true fact about that spot. It works zoomed all the way out or zoomed right in. **Guess mode** (off by default) turns the fact into a 3-option question first. A wrong answer costs nothing, and the full fact is always shown afterwards.

Web prototype: TypeScript + Vite + React + MapLibre GL JS (globe projection), with a small Node/Express API that grounds every fact in real data before Claude writes it.

```
globe-facts/
├── shared/                 # code shared by client + server (no deps; reusable in a native shell)
│   ├── types.ts            # FactRequest / FactResponse / Question / Epoch (time-travel ready)
│   └── geo.ts              # haversine, bearing, antipode, solar position, zoom→scale, geohash precision
├── server/
│   ├── index.ts            # Express: POST /fact (+ /api/fact), GET /api/health, rate limit, serves dist/
│   ├── config.ts           # env vars
│   ├── http.ts             # fetch with timeouts, User-Agent, 1 req/s queues
│   ├── sources/
│   │   ├── land.ts         # OFFLINE: land/ocean, country, coastline distance, antipode (Natural Earth 1:50m)
│   │   └── remote.ts       # Wikipedia, Wikidata, Nominatim, Open-Meteo, Macrostrat, GEBCO, Marine Regions
│   └── engine/
│       ├── gather.ts       # collects structured data for the tapped point, by zoom scale
│       ├── computed.ts     # template facts + questions (fallback, always true)
│       ├── compose.ts      # Claude call: data-only prompt, structured JSON output, grounding check
│       ├── factService.ts  # cache (geohash + scale) → gather → compose → log
│       ├── factLog.ts      # JSONL log: every fact with the exact data it came from
│       ├── cache.ts        # in-memory LRU+TTL (swap for Redis/KV)
│       └── timeTravel.ts   # stretch-goal hook (epochs), not implemented yet
├── src/                    # web client
│   ├── App.tsx             # tap → pin → fly → sheet; guess mode + quiet score
│   ├── components/Globe.tsx      # MapLibre globe, satellite tiles, atmosphere, auto-rotate, inertia
│   ├── components/FactSheet.tsx  # bottom sheet: fact / question / sources, swipe to dismiss
│   └── lib/                # api (with offline fallback), haptics (web + Capacitor), storage
└── tests/                  # vitest: geo, land, computed facts, grounding check, source parsers
```

## Run it

Requires Node 20+.

```bash
cd globe-facts
npm install
cp .env.example .env        # then put your key in ANTHROPIC_API_KEY
npm run dev
```

- Web app: http://localhost:5173 (Vite, proxies `/api` to the API)
- API: http://localhost:8787

**On your phone:** connect it to the same Wi-Fi and open the `Network:` URL Vite prints (e.g. `http://192.168.1.20:5173`). For HTTPS (needed for some browser features, and nicer for "Add to Home Screen"), run a tunnel such as `npx cloudflared tunnel --url http://localhost:5173` and open the URL it prints.

Add `?debug=1` to the URL to get a "show source data" button on each card. It shows the exact JSON that the fact was built from.

Other scripts: `npm test`, `npm run typecheck`, `npm run build`, `npm start` (production server).

## The API key

The key lives only on the server. Put it in `globe-facts/.env` (git-ignored):

```
ANTHROPIC_API_KEY=sk-ant-...
```

Without a key, the app still works. It serves **computed facts**: template sentences built directly from the data, such as coast distance, antipode, rock age, ocean depth, elevation and nearby Wikipedia articles. `GET /api/health` tells you whether Claude is on.

Model settings (optional): `ANTHROPIC_MODEL` (default `claude-opus-5-5`) and `ANTHROPIC_EFFORT` (default `low`, to keep taps fast). Responses are cached, so cost is paid once per place per zoom scale. If you want faster or cheaper uncached taps, try `ANTHROPIC_MODEL=claude-haiku-5-5`.

## How a fact is made

`POST /fact { lat, lon, zoom, mode }`, also at `/api/fact`.

1. **Zoom → scale.** The zoom level maps to a scale: `planet` (<2.5), `country` (<5), `region` (<8), `city` (<12.5) or `local`. Zoomed-out taps get country- or ocean-scale facts. Zoomed-in taps get facts about that exact spot.
2. **Cache.** The cache key is the geohash of the point plus the scale (and the epoch). The geohash cell size matches the scale: about 630 km at planet scale, about 150 m at local scale. Repeat taps return instantly. Identical taps that arrive at the same moment are merged into one request. The client also keeps a small in-memory cache.
3. **Gather.** Sources run in parallel, each with a time limit. Any source can fail without breaking the tap.

   | Priority | Data | Source |
   |---|---|---|
   | 1 – story | Notable articles within 250 m → 1 km → 4 km → 10 km (local/city) | Wikipedia geosearch + extracts |
   | 1 – story | Nearest well-known item within 60 km, then 300 km (deserts, ice, sparse places) | Wikidata SPARQL (`wikibase:around`) |
   | 1 – story | Article for the country / region / city / ocean at this zoom | Wikipedia REST summary (title from Nominatim tags) |
   | 2 – computed | Land or ocean, country, distance + direction to the nearest coast, antipode and what's there | **Offline**: Natural Earth 1:50m via `world-atlas` |
   | 2 – computed | Elevation | Open-Meteo Elevation API (Copernicus DEM) |
   | 2 – computed | Ocean depth | GEBCO 2020 via OpenTopoData |
   | 2 – computed | Rock unit, lithology and age | Macrostrat `geologic_units/map` |
   | 2 – computed | Sun elevation, solar time, subsolar point | computed in `shared/geo.ts` |
   | 3 – place | Place name and level (street / city / region / country) | Nominatim reverse geocoding |
   | 3 – place | Sea / ocean name | Marine Regions gazetteer (falls back to a rough offline label) |

4. **Write.** Claude receives **only** that JSON. The system prompt tells it to use only facts stated in the data, to write at the given scale, and to prefer a story about the spot over computed facts. Structured output returns `{ fact, used[], question{prompt, options[3], correct_index, reveal} }`.
5. **Validate.** Every number in the fact, and in the question's correct answer, must match a number in the source data, allowing for rounding and for "1.2 billion" vs "1200 million" style scaling. If any number is invented, the fact is rejected and the best computed fact is used instead. The same fallback runs if Claude times out, refuses, errors, or returns a malformed question. Server-side refusal fallbacks are enabled on supported models.
6. **Trace.** Every fact is appended to `logs/facts.jsonl` with the request, the full data, the keys the writer says it used, model, token usage and timings. The response carries `sources[]`, which you see by tapping the source line on the card.

Open ocean and deserts still get a good answer, because the computed sources never need the network: "The nearest sizable coastline is about 2,300 km to the south", "Tunnel straight through the Earth from here and you'd come out in New Zealand", or "The seafloor here is about 5,400 m down" (when GEBCO responds).

**Offline / API down:** the client builds a fact on the device from pure computation (antipode, sun position, distance from the equator), so every tap still gets a true answer.

## Guess mode

The toggle is in the top-right corner. When it's on, the card shows a question generated from the same data, such as "How old is the rock under this spot?", "How far is the nearest coast?", "How deep is the water here?", or "Tunnel straight through the Earth from here. Where do you come out?". It has 3 options and a **Just tell me** skip. Any answer reveals the correct option and the full fact. The score (e.g. `12/20`) is stored on the device; skips don't count. Questions written by the computer round the correct answer and the wrong options the same way, so you can't spot the answer by its precision.

## Deploy

The API and web app ship as **one Node service**. Express serves `dist/` in production.

**Docker (any host: Render, Railway, Fly.io, Cloud Run…)**

```bash
docker build -t globe-facts .
docker run -p 8787:8787 -e ANTHROPIC_API_KEY=sk-ant-... -e APP_USER_AGENT="GlobeFacts/0.1 (you@example.com)" globe-facts
```

**Render / Railway without Docker:** set the root directory to `globe-facts`, the build command to `npm ci && npm run build`, and the start command to `npm start`. Add `ANTHROPIC_API_KEY` and `APP_USER_AGENT` as environment variables. The platform's `PORT` is picked up automatically.

Before a public launch:
- **Imagery:** the default Esri World Imagery tiles are fine for a prototype with attribution. For production, use a keyed provider, e.g. MapTiler satellite via `VITE_SATELLITE_TILES` (set at build time).
- **Nominatim** allows at most 1 request/second and needs an identifying User-Agent. Set `APP_USER_AGENT` with contact details. At scale, self-host it or use a commercial geocoder (`NOMINATIM_URL`).
- **OpenTopoData's** public GEBCO endpoint allows 1 request/second and 1,000 a day. Self-host it for real traffic.
- **Cache:** swap the in-memory cache for Redis or KV so it survives restarts and is shared across instances.

## Wrapping as a native app (Capacitor, later)

The client was built with this in mind:
- `shared/` has no dependencies, and the client reads the API origin from `VITE_API_BASE`.
- `src/lib/haptics.ts` already uses `Capacitor.Plugins.Haptics` when it's present, and falls back to the Vibration API.
- Layout uses `env(safe-area-inset-*)`, a fullscreen manifest and `viewport-fit=cover`.

Steps: `npm i @capacitor/core @capacitor/cli @capacitor/haptics`, `npx cap init "Globe Facts" com.example.globefacts --web-dir dist`, then build with `VITE_API_BASE=https://your-api.example npm run build`, then `npx cap add ios` / `npx cap add android`.

## Stretch: time travel (not built)

The architecture is ready for it, but nothing is built yet:
- `FactRequest.epoch` (`'now' | '10y' | '1ky' | '100my'`) is already part of the API contract and the cache key. The server rejects epochs it can't serve.
- `server/engine/timeTravel.ts` defines an `EpochLayer` interface. Each layer adds keys to the data passed to the same compose step.
- The planned data: GPlates Web Service to rotate the point back to its position 100 million years ago, the Macrostrat unit ages already being fetched, and Wikidata items with inception or dissolution dates.

## Known limits of this prototype

- Coastline distance uses 1:50m data (about 5 km resolution) and ignores small islands. Facts therefore say "about" and "nearest sizable coastline".
- The fallback ocean names (when Marine Regions doesn't respond) are coarse, and are marked approximate to the model.
- English Wikipedia only.
