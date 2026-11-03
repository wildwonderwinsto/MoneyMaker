import type { z } from "zod";

/** Error thrown for non-2xx responses after retries are exhausted. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

/** Response body did not match the expected schema. */
export class SchemaError extends Error {
  constructor(
    readonly url: string,
    readonly issues: z.core.$ZodIssue[],
  ) {
    super(
      `Unexpected response shape from ${url}: ${issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}`,
    );
    this.name = "SchemaError";
  }
}

export type QueryValue = string | number | boolean | null | undefined;
export type Query = Record<string, QueryValue | readonly QueryValue[]>;

/** Build a URL; array values repeat the key (`?a=1&a=2`), nullish values are dropped. */
export function buildUrl(base: string, path: string, query: Query = {}): string {
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (v !== undefined && v !== null) url.searchParams.append(key, String(v));
    }
  }
  return url.toString();
}

/**
 * Concurrency + spacing limiter. Keeps us comfortably under public API limits
 * (Polymarket enforces per-IP request budgets and answers 429 when exceeded).
 */
export class RateLimiter {
  private active = 0;
  private nextSlot = 0;
  private readonly queue: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly minIntervalMs: number,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  /** Push the next allowed start time back (e.g. after a 429 with Retry-After). */
  pause(ms: number): void {
    this.nextSlot = Math.max(this.nextSlot, Date.now() + ms);
  }

  private async acquire(): Promise<void> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    const now = Date.now();
    const start = Math.max(now, this.nextSlot);
    this.nextSlot = start + this.minIntervalMs;
    if (start > now) await sleep(start - now);
  }
}

export interface FetchJsonOptions<S extends z.ZodType> {
  schema: S;
  init?: RequestInit;
  limiter?: RateLimiter;
  /** Retries for 429 / 5xx / network errors. */
  retries?: number;
  timeoutMs?: number;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const USER_AGENT = "MoneyMaker/0.1 (+copy-trading research)";

export async function fetchJson<S extends z.ZodType>(
  url: string,
  { schema, init, limiter, retries = 4, timeoutMs = 20_000 }: FetchJsonOptions<S>,
): Promise<z.output<S>> {
  let attempt = 0;
  for (;;) {
    const doFetch = () =>
      fetch(url, {
        ...init,
        headers: { accept: "application/json", "user-agent": USER_AGENT, ...init?.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });

    let res: Response;
    try {
      res = limiter ? await limiter.run(doFetch) : await doFetch();
    } catch (err) {
      if (attempt >= retries) throw err;
      await sleep(backoffMs(attempt++));
      continue;
    }

    if (res.ok) {
      const json: unknown = await res.json();
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new SchemaError(url, parsed.error.issues);
      return parsed.data;
    }

    const body = await res.text().catch(() => "");
    if (!RETRYABLE.has(res.status) || attempt >= retries) {
      throw new HttpError(res.status, url, body);
    }
    const wait = retryAfterMs(res.headers.get("retry-after")) ?? backoffMs(attempt);
    limiter?.pause(wait);
    attempt++;
    await sleep(wait);
  }
}

/** Parse a Retry-After header (delta-seconds or HTTP date) into milliseconds. */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Exponential backoff with full jitter, capped at 30s. */
export function backoffMs(attempt: number): number {
  const cap = Math.min(30_000, 500 * 2 ** attempt);
  return Math.round(cap / 2 + Math.random() * (cap / 2));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
