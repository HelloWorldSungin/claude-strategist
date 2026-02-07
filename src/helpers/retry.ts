/**
 * Retry wrapper with exponential backoff for transient errors.
 */

const TRANSIENT_PATTERNS = [
  /ECONNREFUSED/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /EPIPE/i,
  /timeout/i,
  /network/i,
  /socket hang up/i,
  /503/,
  /502/,
  /429/,
];

function isTransientError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_PATTERNS.some((p) => p.test(msg));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; baseDelayMs?: number; label?: string } = {}
): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 5000, label = "operation" } = opts;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries || !isTransientError(err)) {
        throw err;
      }
      const delay = baseDelayMs * Math.pow(2, attempt);
      console.warn(
        `[retry] ${label} attempt ${attempt + 1}/${maxRetries} failed (transient), retrying in ${delay}ms...`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // Unreachable, but satisfies TypeScript
  throw new Error(`${label} failed after ${maxRetries} retries`);
}
