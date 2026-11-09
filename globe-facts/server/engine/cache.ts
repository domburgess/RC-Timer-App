// Tiny in-memory LRU cache with per-entry TTL.
// Swap for Redis / Cloudflare KV in production: the interface is just get/set.

export class TtlCache<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(
    private max: number,
    private defaultTtlMs: number,
  ) {}

  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // refresh LRU position
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }

  set(key: string, v: V, ttlMs = this.defaultTtlMs): void {
    this.map.delete(key);
    this.map.set(key, { v, exp: Date.now() + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }

  get size() {
    return this.map.size;
  }
}
