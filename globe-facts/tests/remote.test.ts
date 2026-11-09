// Parsers for each network source, against response shapes from the providers' docs.
import { afterEach, describe, expect, it, vi } from 'vitest';

const respond = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));

afterEach(() => vi.unstubAllGlobals());

describe('remote sources', () => {
  it('parses Macrostrat geologic units', async () => {
    vi.stubGlobal('fetch', respond({
      success: { v: 2, data: [{ map_id: 1, name: 'Chalk Group', strat_name: 'Chalk', lith: 'Chalk, limestone',
        descrip: 'White chalk', b_int_name: 'Cenomanian', t_int_name: 'Maastrichtian', b_int_age: 100.5, t_int_age: 66 }] },
    }));
    const { geology } = await import('../server/sources/remote');
    const g = await geology(50.9, 0.1, 'city');
    expect(g?.name).toBe('Chalk Group');
    expect(g?.ageText).toBe('between 66 and 101 million years old');
  });

  it('parses Wikipedia geosearch + extracts', async () => {
    const fetch = vi.fn(async (url: string) => {
      const body = url.includes('geosearch')
        ? { query: { geosearch: [{ pageid: 1, title: 'Big Ben', lat: 51.5007, lon: -0.1246, dist: 12.3 }] } }
        : { query: { pages: [{ pageid: 1, title: 'Big Ben', description: 'Clock tower', extract: 'Big Ben is the nickname...', fullurl: 'https://en.wikipedia.org/wiki/Big_Ben' }] } };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetch);
    const { wikiNearby } = await import('../server/sources/remote');
    const r = await wikiNearby(51.5008, -0.1247, [250]);
    expect(r?.[0]).toMatchObject({ title: 'Big Ben', distanceKm: 0.012, url: 'https://en.wikipedia.org/wiki/Big_Ben' });
  });

  it('parses Open-Meteo elevation and handles failures as null', async () => {
    vi.stubGlobal('fetch', respond({ elevation: [8848.0] }));
    const { elevation } = await import('../server/sources/remote');
    expect(await elevation(27.988, 86.925)).toEqual({ meters: 8848, feet: 29029 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })));
    expect(await elevation(1.234, 5.678)).toBeNull();
  });

  it('parses GEBCO depth', async () => {
    vi.stubGlobal('fetch', respond({ results: [{ dataset: 'gebco2020', elevation: -10920, location: { lat: 11.35, lng: 142.2 } }], status: 'OK' }));
    const { oceanDepth } = await import('../server/sources/remote');
    expect(await oceanDepth(11.35, 142.2)).toEqual({ meters: -10920 });
  });
});
