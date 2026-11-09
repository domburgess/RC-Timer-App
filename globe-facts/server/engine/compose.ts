// Turns gathered PlaceData into one punchy fact (+ a guess-mode question) with Claude.
// Claude sees ONLY the structured data; the output is validated against that data
// and anything ungrounded is rejected in favour of a computed fact.

import Anthropic from '@anthropic-ai/sdk';
import type { Question } from '../../shared/types';
import { config } from '../config';
import type { PlaceData } from './gather';

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!config.useClaude || !config.anthropicApiKey) return null;
  client ??= new Anthropic({ apiKey: config.anthropicApiKey, timeout: 20_000, maxRetries: 1 });
  return client;
}
export const claudeEnabled = () => getClient() !== null;

// Models that accept the server-side refusal fallback parameter.
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-sonnet-5-5']);

const SYSTEM = `You write the single fact a person sees after tapping a spot on a 3D globe in the app "Globe Facts".

You receive JSON describing the tapped point. It is your only source of truth.
- Use only facts stated in the JSON. Do not add names, dates, numbers, superlatives or causes that are not in it, even if you believe them. If the JSON does not say it, leave it out.
- Copy numbers as given (rounding is fine). Do not convert units unless both units are in the data.
- Write at the "scale" given: planet or country means a country- or ocean-scale fact; region or city means that area; local means this exact spot or the closest thing in "nearby".
- Prefer, in order: a specific story about this spot ("nearby", then "nearestNotable"), something surprising about the area ("area"), then a striking computed fact (deep rock age, ocean depth, distance from the sea, a land antipode, unusual elevation). Avoid "sun" and "weather" unless nothing else is interesting; they change over time.
- "coast" is the distance to the nearest coastline of a sizable landmass, approximate to about 5 km; say "about", and at sea say "the nearest sizable coastline" rather than "the nearest land" (small islands may be closer). "solarTime" is solar time, not clock time. Ocean names flagged "nameIsApproximate" should be given loosely ("in the Pacific") or not at all.
- Style: 1-2 short sentences, at most 260 characters, plain words, second person is fine ("You're standing on..."). Lead with the interesting part. No preamble, no emoji, no questions in the fact.

Also write one multiple-choice question for "guess mode", based on the same data:
- 3 options, exactly one correct according to the data. Wrong options must be plausible but clearly wrong if you know the answer. Keep options short (under 40 characters).
- "reveal" is the full fact that is shown after answering; it must state the correct answer. It may be the same as "fact".
- If the main fact does not suit a question, base the question on another fact in the data.

"used" lists the top-level JSON keys you relied on (for "nearby", use "nearby.0", "nearby.1", ... for each article used).`;

const SCHEMA = {
  type: 'object',
  properties: {
    fact: { type: 'string' },
    used: { type: 'array', items: { type: 'string' } },
    question: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        options: { type: 'array', items: { type: 'string' } },
        correct_index: { type: 'integer' },
        reveal: { type: 'string' },
      },
      required: ['prompt', 'options', 'correct_index', 'reveal'],
      additionalProperties: false,
    },
  },
  required: ['fact', 'used', 'question'],
  additionalProperties: false,
} as const;

export interface Composed {
  fact: string;
  used: string[];
  question?: Question;
  model: string;
  usage?: { input: number; output: number };
}

/** Strip noisy fields before sending to the model (keeps the prompt small and focused). */
export function promptData(d: PlaceData): Record<string, unknown> {
  const { sun, weather, ...rest } = d;
  return {
    ...rest,
    nearby: d.nearby?.map(({ url: _u, ...a }) => a),
    nearestNotable: d.nearestNotable ? (({ url: _u, ...a }) => a)(d.nearestNotable) : undefined,
    area: d.area ? (({ url: _u, ...a }) => a)(d.area) : undefined,
    geology: d.geology ? (({ url: _u, ...g }) => g)(d.geology) : undefined,
    sun: sun && {
      elevationDeg: sun.elevationDeg,
      solarTime: sun.solarTime,
      subsolar: sun.subsolar,
      isDay: sun.isDay,
      computedAtUtc: sun.computedAtUtc,
      note: sun.note,
    },
    weather: weather && { temperatureC: weather.temperatureC, timezone: weather.timezone },
  };
}

export async function composeWithClaude(d: PlaceData): Promise<Composed | null> {
  const c = getClient();
  if (!c) return null;
  const data = promptData(d);
  const useFallbacks = FALLBACK_MODELS.has(config.model) && process.env.CLAUDE_FALLBACKS !== '0';

  const res = await c.beta.messages.create({
    model: config.model,
    max_tokens: 4000,
    ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    output_config: { effort: config.effort, format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify(data) }],
  });

  if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') {
    console.warn(`[claude] stop_reason=${res.stop_reason}; using computed fact`);
    return null;
  }
  const text = res.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  let out: { fact: string; used: string[]; question: { prompt: string; options: string[]; correct_index: number; reveal: string } };
  try {
    out = JSON.parse(text);
  } catch {
    console.warn('[claude] unparseable output; using computed fact');
    return null;
  }

  const fact = out.fact?.trim();
  if (!fact || fact.length > 400) return null;

  const problems = unsupportedNumbers(fact, data);
  if (problems.length) {
    console.warn(`[claude] rejected fact with ungrounded numbers ${problems.join(', ')}: ${fact}`);
    return null;
  }

  let question: Question | undefined;
  const q = out.question;
  if (
    q &&
    Array.isArray(q.options) &&
    q.options.length === 3 &&
    new Set(q.options).size === 3 &&
    Number.isInteger(q.correct_index) &&
    q.correct_index >= 0 &&
    q.correct_index < 3 &&
    q.reveal &&
    unsupportedNumbers(`${q.options[q.correct_index]} ${q.reveal}`, data).length === 0
  ) {
    question = { prompt: q.prompt, options: q.options, correctIndex: q.correct_index, reveal: q.reveal };
  }

  return {
    fact,
    used: Array.isArray(out.used) ? out.used.map(String) : [],
    question,
    model: res.model,
    usage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
  };
}

// ------------------------------------------------------------- grounding check

function numbersIn(text: string): number[] {
  return (text.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [])
    .map((s) => Number(s.replace(/,/g, '')))
    .filter((n) => Number.isFinite(n));
}

function collectNumbers(v: unknown, out: number[]) {
  if (typeof v === 'number') out.push(v);
  else if (typeof v === 'string') out.push(...numbersIn(v));
  else if (Array.isArray(v)) v.forEach((x) => collectNumbers(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => collectNumbers(x, out));
}

/**
 * Every number in `text` must be close to some number in the source data
 * (allowing rounding, and "1.2 billion" / "252 million" style scaling).
 * Small integers (0-12) are allowed: they are usually counts or ordinals in prose.
 */
export function unsupportedNumbers(text: string, data: unknown): number[] {
  const pool: number[] = [];
  collectNumbers(data, pool);
  const abs = pool.map(Math.abs);
  const near = (n: number) =>
    abs.some((m) => {
      for (const k of [1, 1000, 1e6, 0.001]) {
        const mm = m / k;
        if (Math.abs(mm - n) <= Math.max(0.6, 0.06 * n)) return true;
      }
      return false;
    });
  return numbersIn(text)
    .map(Math.abs)
    .filter((n) => n > 12 && !near(n));
}
