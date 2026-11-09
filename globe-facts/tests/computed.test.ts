import { describe, expect, it } from 'vitest';
import { bestComputed, computedCandidates, makeQuestion, sig2 } from '../server/engine/computed';
import type { PlaceData } from '../server/engine/gather';

const base: PlaceData = {
  point: { lat: 23, lon: 12, label: '23.00°N, 12.00°E', hemisphere: 'Northern and Eastern', kmFromEquator: 2557 },
  scale: 'region',
  surface: 'land',
  country: 'Niger',
  coast: { km: 1004, direction: 'north', nearestCoastCountry: 'Libya', approximateToKm: 5, note: '' },
  antipode: { lat: -23, lon: -168, label: '23.00°S, 168.00°W', surface: 'ocean', country: null, ocean: 'South Pacific Ocean' },
};

describe('computed facts', () => {
  it('always produces a fact, even with no network data', () => {
    const c = bestComputed(base);
    expect(c.fact.length).toBeGreaterThan(20);
    expect(c.question?.options).toHaveLength(3);
    expect(c.question?.reveal).toBeTruthy();
  });
  it('prefers a nearby story at local scale', () => {
    const c = computedCandidates({
      ...base,
      scale: 'local',
      nearby: [{ title: 'Big Ben', extract: 'Big Ben is the nickname for the Great Bell.', url: 'u', distanceKm: 0.05 }],
    });
    expect(c[0].keys).toEqual(['nearby.0']);
    expect(c[0].fact).toMatch(/^Right here: Big Ben/);
  });
  it('questions have three distinct options and a valid answer', () => {
    const q = makeQuestion('Q?', 'a', ['b', 'c', 'a'], 1)!;
    expect(new Set(q.options).size).toBe(3);
    expect(q.options[q.correctIndex]).toBe('a');
  });
  it('rounds consistently', () => {
    expect(sig2(4518)).toBe(4500);
    expect(sig2(181)).toBe(180);
  });
});
