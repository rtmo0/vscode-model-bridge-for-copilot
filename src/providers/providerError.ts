/** A provider HTTP failure that keeps its status and `Retry-After`, so combos can route around it. */
export class ProviderHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) {
    super(message);
  }
}

/** An error that says when its backend can be tried again; combos honor it as the cooldown. */
export type RetryAfterError = Error & { retryAfterMs?: number };

/** Reads `Retry-After` (seconds or an HTTP date) or `retry-after-ms`. */
export function parseRetryAfter(
  headers: { get(name: string): string | null } | undefined,
  now = Date.now()
): number | undefined {
  const milliseconds = readNonNegative(headers?.get('retry-after-ms'));
  if (milliseconds !== undefined) return milliseconds;
  const value = headers?.get('retry-after')?.trim();
  if (!value) return undefined;
  const seconds = readNonNegative(value);
  if (seconds !== undefined) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function readNonNegative(value: string | null | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

export function getRetryAfterMs(error: unknown): number | undefined {
  const value = (error as { retryAfterMs?: unknown } | undefined)?.retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
