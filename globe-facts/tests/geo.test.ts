import { describe, expect, it } from 'vitest';
import { antipode, bearingDeg, compass, haversineKm, scaleForZoom, sunInfo } from '../shared/geo';

describe('geo', () => {
  it('haversine London -> Paris ~ 344 km', () => {
    expect(haversineKm(51.5074, -0.1278, 48.8566, 2.3522)).toBeGreaterThan(340);
    expect(haversineKm(51.5074, -0.1278, 48.8566, 2.3522)).toBeLessThan(348);
  });
  it('antipode wraps longitude', () => {
    expect(antipode(40.4, -3.7).lat).toBe(-40.4);
    expect(antipode(40.4, -3.7).lon).toBeCloseTo(176.3);
    expect(antipode(10, 170).lon).toBeCloseTo(-10);
  });
  it('bearing and compass', () => {
    expect(compass(bearingDeg(0, 0, 10, 0))).toBe('north');
    expect(compass(bearingDeg(0, 0, 0, 10))).toBe('east');
  });
  it('sun is overhead near the subsolar point at the June solstice', () => {
    const s = sunInfo(23.4, 0, new Date('2026-06-21T12:00:00Z'));
    expect(s.elevationDeg).toBeGreaterThan(88);
    expect(s.subsolar.lat).toBeCloseTo(23.4, 0);
    expect(s.solarTime).toBe('12:00');
  });
  it('zoom -> scale', () => {
    expect(scaleForZoom(0.5)).toBe('planet');
    expect(scaleForZoom(4)).toBe('country');
    expect(scaleForZoom(15)).toBe('local');
  });
});
