import { describe, expect, it } from 'vitest';
import { countryAt, isLand, nearestCoast, nearestCountry } from '../server/sources/land';

describe('land (Natural Earth, offline)', () => {
  it('knows land from ocean', () => {
    expect(isLand(48.85, 2.35)).toBe(true); // Paris
    expect(isLand(0, -140)).toBe(false); // Pacific
    expect(isLand(-80, 30)).toBe(true); // Antarctica
  });
  it('finds countries, with readable names', () => {
    expect(countryAt(35.68, 139.69)).toBe('Japan');
    expect(countryAt(-80, 30)).toBe('Antarctica');
    expect(countryAt(-4.3, 15.3)).toMatch(/Congo/);
    expect(countryAt(-1.3, 23)).toBe('Democratic Republic of the Congo');
    expect(nearestCountry(36.8, -121.95)).toBe('United States');
  });
  it('coast distance is plausible', () => {
    const kansas = nearestCoast(38.5, -98);
    expect(kansas.km).toBeGreaterThan(800);
    expect(kansas.km).toBeLessThan(1300);
    expect(nearestCoast(-33.86, 151.2).km).toBeLessThan(20); // Sydney
  });
});
