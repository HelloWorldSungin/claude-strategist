/**
 * Strategy Watchdog Cron Job
 *
 * Runs every hour. NO Claude spawn (cheap/fast).
 * Checks service health and state freshness.
 * Sends Discord alert only on failure.
 *
 * Schedule: 15 * * * *
 */

import { stateAge } from "../helpers/state";
import { sendDiscord } from "../helpers/discord";

const OHLCV_URL = "http://localhost:8812/health";
const DB_CHECK_CMD = `psql "postgresql://trading_app:trading_app_2026@192.168.68.120:5433/trading" -c "SELECT 1" -t -A`;
const MAX_REGIME_AGE_SECONDS = 4 * 3600; // 4 hours

async function main() {
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

  // 4. Report
  if (issues.length > 0) {
    const alert =
      `Strategist Watchdog Alert:\n\n` +
      issues.map((i) => `- ${i}`).join("\n");
    console.error(`[watchdog] Issues found:\n${alert}`);
    await sendDiscord(alert);
  } else {
    console.log("[watchdog] All checks passed");
  }
}

main().catch((err) => {
  console.error("[watchdog] Fatal:", err);
  process.exit(1);
});
