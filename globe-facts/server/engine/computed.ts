// Template-based facts and questions built directly from PlaceData.
// Used when Claude is unavailable / disabled / fails validation, and as the
// guaranteed question source. Every sentence here is a direct restatement of data.

import type { Question, Scale } from '../../shared/types';
import { formatKm } from '../../shared/geo';
import type { PlaceData } from './gather';
import { humanAge } from '../sources/remote';

export interface Candidate {
  fact: string;
  keys: string[];
  score: number;
  question?: Question;
  /** Depends on the current time (sun, weather): cache briefly. */
  volatile?: boolean;
}

const firstSentences = (text: string, maxChars = 230): string => {
  const parts = text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+(\s|$)/g) ?? [text];
  let out = '';
  for (const p of parts) {
    if (out && (out + p).length > maxChars) break;
    out += p;
  }
  return out.trim() || text.slice(0, maxChars);
};

function shuffle<T>(xs: T[], seed: number): T[] {
  const a = xs.slice();
  let s = Math.abs(Math.floor(seed * 1e6)) || 1;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 16807) % 2147483647;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function makeQuestion(prompt: string, correct: string, wrong: string[], seed: number): Question | undefined {
  const uniq = [...new Set(wrong.filter((w) => w && w !== correct))].slice(0, 2);
  if (uniq.length < 2) return undefined;
  const options = shuffle([correct, ...uniq], seed);
  return { prompt, options, correctIndex: options.indexOf(correct) };
}

/** Round to 2 significant figures so correct answers and distractors look alike. */
export function sig2(n: number): number {
  if (n === 0) return 0;
  const p = 10 ** (Math.floor(Math.log10(Math.abs(n))) - 1);
  return Math.round(n / p) * p;
}
const kmRounded = (km: number) => formatKm(km >= 10 ? sig2(km) : km);
const meters = (m: number) => `${sig2(m).toLocaleString('en-US')} m`;
const distanceOptions = (km: number) => [kmRounded(km * 0.18), kmRounded(km * 4.5)];
const SCORE: Record<Scale, Record<string, number>> = {
  planet: { nearby: 0, area: 90, notable: 0, geology: 60, depth: 85, coast: 70, antipode: 75, elevation: 55 },
  country: { nearby: 0, area: 88, notable: 0, geology: 70, depth: 85, coast: 75, antipode: 70, elevation: 60 },
  region: { nearby: 70, area: 80, notable: 60, geology: 78, depth: 85, coast: 75, antipode: 60, elevation: 70 },
  city: { nearby: 85, area: 75, notable: 65, geology: 72, depth: 85, coast: 70, antipode: 55, elevation: 65 },
  local: { nearby: 100, area: 60, notable: 70, geology: 70, depth: 85, coast: 65, antipode: 50, elevation: 65 },
};

export function computedCandidates(d: PlaceData): Candidate[] {
  const c: Candidate[] = [];
  const sc = SCORE[d.scale];
  const seed = d.point.lat * 31 + d.point.lon;

  const near = d.nearby?.[0];
  if (near) {
    const where =
      (near.distanceKm ?? 0) < 0.15
        ? 'Right here'
        : `${formatKm(near.distanceKm!)}${near.direction ? ` ${near.direction}` : ''} of this spot`;
    c.push({ fact: `${where}: ${firstSentences(near.extract)}`, keys: ['nearby.0'], score: sc.nearby });
  }

  if (d.area) c.push({ fact: firstSentences(d.area.extract), keys: ['area'], score: sc.area });

  if (d.nearestNotable?.extract && d.nearestNotable.distanceKm) {
    const n = d.nearestNotable;
    c.push({
      fact: `The nearest well-known place is ${n.title}, about ${kmRounded(n.distanceKm!)} ${n.direction ?? 'away'}. ${firstSentences(n.extract, 160)}`,
      keys: ['nearestNotable'],
      score: sc.notable,
    });
  }

  const g = d.geology;
  if (g?.oldestMa !== undefined && g.ageText) {
    const lith = g.lithology?.split(/[,;]/)[0]?.trim().toLowerCase();
    const correct = humanAge(g.oldestMa);
    c.push({
      fact: `The rock beneath this spot is ${g.ageText}${lith ? `, mostly ${lith}` : ''} (${g.name}).`,
      keys: ['geology'],
      score: sc.geology + (g.oldestMa > 1000 ? 15 : 0),
      question: makeQuestion(
        'How old is the rock under this spot?',
        correct,
        [humanAge(Math.max(0.01, g.oldestMa * 0.07)), humanAge(Math.min(4000, g.oldestMa * 9 + 50))],
        seed,
      ),
    });
  }

  if (d.ocean?.depthMeters) {
    const m = d.ocean.depthMeters;
    c.push({
      fact: `The seafloor here is about ${m.toLocaleString('en-US')} m (${d.ocean.depthFeet!.toLocaleString('en-US')} ft) below the surface${d.ocean.nameIsApproximate ? '' : ` of the ${d.ocean.name.replace(/^the /i, '')}`}.`,
      keys: ['ocean'],
      score: sc.depth + (m > 5000 ? 10 : 0),
      question: makeQuestion(
        'How deep is the water here?',
        meters(m),
        [meters(m * 0.22), meters(m * 2.6 + 400)],
        seed,
      ),
    });
  }

  if (d.coast && d.coast.km >= 30) {
    const km = d.coast.km;
    const fact =
      d.surface === 'land'
        ? `This spot is about ${kmRounded(km)} from the sea: the nearest coastline lies to the ${d.coast.direction}.`
        : `The nearest sizable coastline is about ${kmRounded(km)} to the ${d.coast.direction}${d.coast.nearestCoastCountry ? `, in ${theName(d.coast.nearestCoastCountry)}` : ''}.`;
    c.push({
      fact,
      keys: ['coast'],
      score: sc.coast + Math.min(25, km / 40),
      question: makeQuestion(
        d.surface === 'land' ? 'How far is the nearest coast?' : 'How far away is the nearest big coastline?',
        kmRounded(km),
        distanceOptions(km),
        seed,
      ),
    });
  }

  if (d.antipode) {
    const a = d.antipode;
    const there =
      a.surface === 'land' && a.country ? theName(a.country) : a.surface === 'land' ? `land at ${a.label}` : `the ${a.ocean}`;
    const decoys = ['the Indian Ocean', 'the South Pacific Ocean', 'the North Atlantic Ocean', 'Australia', 'Argentina', 'China', 'New Zealand'];
    c.push({
      fact: `If you could tunnel straight through the Earth from here, you'd come out in ${there} (${a.label}).`,
      keys: ['antipode'],
      score: sc.antipode + (a.surface === 'land' ? 20 : 0),
      question: makeQuestion(
        'Tunnel straight through the Earth from here. Where do you come out?',
        there,
        shuffle(decoys.filter((x) => !there.includes(x.replace(/^the /, ''))), seed + 1),
        seed,
      ),
    });
  }

  if (d.elevation && d.surface === 'land') {
    const m = d.elevation.meters;
    const notable = m >= 1500 || m < 0;
    const correct = meters(m);
    c.push({
      fact:
        m < 0
          ? `This spot lies ${Math.abs(m).toLocaleString('en-US')} m (${Math.abs(d.elevation.feet).toLocaleString('en-US')} ft) below sea level.`
          : `This spot sits ${m.toLocaleString('en-US')} m (${d.elevation.feet.toLocaleString('en-US')} ft) above sea level.`,
      keys: ['elevation'],
      score: sc.elevation + (notable ? 15 : -25),
      question:
        Math.abs(m) >= 50
          ? makeQuestion(
              'How high above sea level is this spot?',
              correct,
              [meters(m * 0.3), meters(m * 2.4 + 300)],
              seed,
            )
          : undefined,
    });
  }

  if (d.sun) {
    const s = d.sun;
    c.push({
      fact:
        s.elevationDeg > 0
          ? `Right now the sun is ${s.elevationDeg}° above the horizon here; it is directly overhead at ${fmt(s.subsolar)}.`
          : `It's night here: the sun is ${Math.abs(s.elevationDeg)}° below the horizon, and directly overhead at ${fmt(s.subsolar)}.`,
      keys: ['sun'],
      score: 30,
      volatile: true,
    });
  }

  c.push({
    fact: `This spot is ${d.point.kmFromEquator.toLocaleString('en-US')} km ${d.point.lat >= 0 ? 'north' : 'south'} of the equator, in the ${d.point.hemisphere} hemispheres.`,
    keys: ['point'],
    score: 10,
  });

  return c.sort((a, b) => b.score - a.score);
}

/** "United States" -> "the United States", "France" -> "France". */
export function theName(n: string): string {
  return /^(United|Democratic|Central African|Dominican|Czech|Netherlands|Philippines|Bahamas|Gambia|Maldives|Marshall|Solomon|Cook|Falkland|Cayman|Faroe|Pitcairn|British|U\.S\.|French Southern|Northern Mariana|Turks|Heard|Ashmore|Australian|Comoros|Seychelles)/.test(n)
    ? `the ${n}`
    : n;
}

function fmt(p: { lat: number; lon: number }) {
  return `${Math.abs(p.lat).toFixed(1)}°${p.lat >= 0 ? 'N' : 'S'}, ${Math.abs(p.lon).toFixed(1)}°${p.lon >= 0 ? 'E' : 'W'}`;
}

/** Best computed fact plus the best available question. */
export function bestComputed(d: PlaceData): Candidate {
  const cands = computedCandidates(d);
  const top = cands[0];
  const withQ = top.question ? top : cands.find((x) => x.question);
  const question = withQ?.question ? { ...withQ.question, reveal: withQ.fact } : undefined;
  return { ...top, question };
}

export function computedQuestions(d: PlaceData): Candidate[] {
  return computedCandidates(d).filter((c) => c.question);
}
