// STRETCH (not built yet): "time travel" on a tap.
//
// The API already accepts `epoch` on POST /fact and the cache key includes it, so adding
// this is additive. Plan:
//   - 10y:    Open-Meteo historical weather / land-cover change (e.g. Copernicus).
//   - 1ky:    Wikipedia/Wikidata items with inception/dissolution dates near the point.
//   - 100my:  Rotate the point back in time with GPlates Web Service
//             (https://gws.gplates.org/reconstruct/reconstruct_points/?points=lon,lat&time=100)
//             and pair it with Macrostrat units whose age range covers that time
//             (we already fetch oldestMa / youngestMa for the current point).
// Each layer returns extra keys for PlaceData (e.g. `past: { epoch, paleoLat, paleoLon, ... }`),
// and the same compose step writes the fact.

import type { Epoch } from '../../shared/types';

export interface EpochLayer {
  epoch: Exclude<Epoch, 'now'>;
  gather(lat: number, lon: number): Promise<Record<string, unknown> | null>;
}

export const epochLayers: EpochLayer[] = [];

export function isEpochSupported(epoch: Epoch | undefined): boolean {
  return !epoch || epoch === 'now' || epochLayers.some((l) => l.epoch === epoch);
}
