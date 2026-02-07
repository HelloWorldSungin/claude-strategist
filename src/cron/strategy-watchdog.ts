/**
 * Strategy Watchdog Cron Job
 *
 * Runs every hour. NO Claude spawn (cheap/fast).
 * Checks service health, state freshness, and cron job freshness.
 * Sends Discord alert only on failure.
 *
 * Schedule: 15 * * * *
 */

import { stateAge } from "../helpers/state";
import { sendDiscord } from "../helpers/discord";
import { logCronRun, getLastCronSuccess } from "../helpers/db";

const OHLCV_URL = "http://localhost:8812/health";
const DB_CHECK_CMD = `psql "postgresql://trading_app:trading_app_2026@192.168.68.120:5433/trading" -c "SELECT 1" -t -A`;
const MAX_REGIME_AGE_SECONDS = 4 * 3600; // 4 hours
const MAX_MARKET_ANALYSIS_GAP_MS = 4 * 3600 * 1000; // 4 hours
const MAX_TRADE_REVIEW_GAP_MS = 12 * 3600 * 1000; // 12 hours

async function main() {
  const startTime = Date.now();
  console.log(`[watchdog] Starting at ${new Date().toISOString()}`);

  const issues: string[] = [];

  // 1. OHLCV service health
  try {
    const resp = await fetch(OHLCV_URL, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      issues.push(`OHLCV service unhealthy: HTTP ${resp.status}`);
    }
  } catch (err) {
    issues.push(
      `OHLCV service unreachable: ${err instanceof Error ? err.message : "unknown"}`
    );
  }

  // 2. PostgreSQL connectivity
  try {
    const { spawn } = await import("bun");
    const proc = spawn(["bash", "-c", DB_CHECK_CMD], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      issues.push(`PostgreSQL check failed: ${stderr.substring(0, 100)}`);
    }
  } catch (err) {
    issues.push(
      `PostgreSQL check error: ${err instanceof Error ? err.message : "unknown"}`
    );
  }

  // 3. State file freshness
  const regimeAge = await stateAge("market-regime.json");
  if (regimeAge === null) {
    issues.push("market-regime.json: file missing");
  } else if (regimeAge > MAX_REGIME_AGE_SECONDS) {
    const hours = (regimeAge / 3600).toFixed(1);
    issues.push(`market-regime.json: stale (${hours}h old, max 4h)`);
  }

  // 4. Cron job freshness (check last successful runs)
  try {
    const lastMarket = await getLastCronSuccess("market-analysis");
    if (lastMarket) {
      const gap = Date.now() - new Date(lastMarket).getTime();
      if (gap > MAX_MARKET_ANALYSIS_GAP_MS) {
        const hours = (gap / 3600000).toFixed(1);
        issues.push(
          `market-analysis cron: last success ${hours}h ago (max 4h)`
        );
      }
    }

    const lastReview = await getLastCronSuccess("trade-review");
    if (lastReview) {
      const gap = Date.now() - new Date(lastReview).getTime();
      if (gap > MAX_TRADE_REVIEW_GAP_MS) {
        const hours = (gap / 3600000).toFixed(1);
        issues.push(
          `trade-review cron: last success ${hours}h ago (max 12h)`
        );
      }
    }
  } catch (err) {
    console.error("[watchdog] Cron freshness check error:", err);
  }

  // 5. Report
  if (issues.length > 0) {
    const alert =
      `Strategist Watchdog Alert:\n\n` +
      issues.map((i) => `- ${i}`).join("\n");
    console.error(`[watchdog] Issues found:\n${alert}`);
    await sendDiscord(alert);
  } else {
    console.log("[watchdog] All checks passed");
  }

  await logCronRun({
    job_name: "strategy-watchdog",
    status: issues.length > 0 ? "failure" : "success",
    duration_ms: Date.now() - startTime,
    error_message:
      issues.length > 0 ? issues.join("; ") : undefined,
  });
}

main().catch(async (err) => {
  console.error("[watchdog] Fatal:", err);
  await logCronRun({
    job_name: "strategy-watchdog",
    status: "failure",
    error_message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
