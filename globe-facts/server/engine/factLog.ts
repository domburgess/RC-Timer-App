// Append-only JSONL log of every generated fact with the exact data it was built from,
// so any fact can be traced back to its sources. One line per fact.

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from '../config';

let ready: Promise<unknown> | null = null;

export function logFact(entry: Record<string, unknown>): void {
  const line = JSON.stringify(entry) + '\n';
  if (process.env.LOG_FACTS_TO_STDOUT === '1') process.stdout.write(line);
  if (!config.factLogPath) return;
  ready ??= mkdir(dirname(config.factLogPath), { recursive: true });
  ready
    .then(() => appendFile(config.factLogPath, line))
    .catch((err) => console.warn(`[log] could not write fact log: ${err.message}`));
  console.log(`[fact] ${entry.writer} ${entry.key} ${(entry.ms as { total: number }).total}ms :: ${entry.fact}`);
}
