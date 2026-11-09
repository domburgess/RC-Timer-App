// Types shared by the web client and the API server.
// Keep this file dependency-free so it can be reused by a native (Capacitor) shell.

export type Mode = 'fact' | 'guess';

/**
 * Stretch goal (not built yet): "time travel" on a tap.
 * The request already carries an epoch so the API contract does not have to change
 * when paleogeography layers are added. Only 'now' is served today.
 */
export type Epoch = 'now' | '10y' | '1ky' | '100my';

/** The spatial scale a fact should be written at, derived from map zoom. */
export type Scale = 'planet' | 'country' | 'region' | 'city' | 'local';

export interface FactRequest {
  lat: number;
  lon: number;
  zoom: number;
  mode: Mode;
  epoch?: Epoch;
}

export interface Question {
  prompt: string;
  /** Exactly three options. */
  options: string[];
  correctIndex: number;
  /** The full fact shown after answering (defaults to FactResponse.fact). */
  reveal?: string;
}

export interface SourceRef {
  /** Key into FactResponse.data, e.g. "wikipedia", "geology". */
  key: string;
  label: string;
  url?: string;
}

export interface FactResponse {
  id: string;
  lat: number;
  lon: number;
  scale: Scale;
  /** Human place label, e.g. "Westminster, London" or "North Pacific Ocean". */
  place: string;
  /** One short, true fact (1-2 sentences). */
  fact: string;
  /** Present when the server could build a question (guess mode uses it). */
  question?: Question;
  /** Which data the fact was built from. */
  sources: SourceRef[];
  /** 'claude' when written by the model, 'computed' when built from templates. */
  writer: 'claude' | 'computed' | 'offline';
  cached: boolean;
  /** The structured data the fact was grounded on (for debugging / traceability). */
  data?: Record<string, unknown>;
}
