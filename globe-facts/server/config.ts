import 'dotenv/config';

const num = (v: string | undefined, d: number) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);

export const config = {
  port: num(process.env.PORT, 8787),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  model: process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
  effort: (process.env.ANTHROPIC_EFFORT || 'low') as 'low' | 'medium' | 'high',
  /** Set to "0" to use only template (computed) facts and skip the model entirely. */
  useClaude: process.env.USE_CLAUDE !== '0',
  /** Nominatim's usage policy requires an identifying User-Agent. Put a contact URL/email here. */
  userAgent: process.env.APP_USER_AGENT || 'GlobeFacts/0.1 (prototype)',
  nominatimUrl: process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org',
  nominatimEmail: process.env.NOMINATIM_EMAIL || '',
  factLogPath: process.env.FACT_LOG_PATH || 'logs/facts.jsonl',
  cacheMaxEntries: num(process.env.CACHE_MAX_ENTRIES, 5000),
  /** Requests per minute per IP (protects your Anthropic bill). */
  rateLimitPerMin: num(process.env.RATE_LIMIT_PER_MIN, 30),
  /** Total time budget for gathering source data, ms. */
  gatherBudgetMs: num(process.env.GATHER_BUDGET_MS, 6000),
};
