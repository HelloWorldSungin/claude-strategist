/**
 * Market Analysis Cron Job
 *
 * Runs every 2 hours. Spawns Claude to assess BTC/ETH regime,
 * writes state/market-regime.json, logs to strategist.regime_log.
 * Sends Discord notification if regime changed.
 *
 * Schedule: 0 */2 * * *
 */

import { buildCronPrompt } from "../helpers/prompt-builder";
import { runClaudeLocal } from "../helpers/claude-runner";
import { readState, writeState } from "../helpers/state";
import { sendDiscord } from "../helpers/discord";
import type { MarketRegimeState } from "../types";

async function main() {
  console.log(`[market-analysis] Starting at ${new Date().toISOString()}`);

  // Read previous regime for comparison
  const prevRegime = await readState<MarketRegimeState>("market-regime.json");
  const prevRegimeValue = prevRegime?.regime || null;

  const prompt = await buildCronPrompt(
    "Market regime assessment for BTC and ETH.\n\n" +
      "1. Use the OHLCV service (localhost:8812) to fetch recent BTC-USD and ETH-USD 1h candles (limit 24)\n" +
      "2. Calculate current price and 24h change for both\n" +
      "3. Determine regime: RALLY (BTC >+3%), SELLOFF (BTC <-3%), NEUTRAL\n" +
      "4. Assess trading bias (e.g., 'favor shorts', 'favor longs', 'neutral/wait')\n" +
      "5. Write JSON to strategist/state/market-regime.json:\n" +
      "   {regime, btc_price, btc_24h_change, eth_price, eth_24h_change, trading_bias, confidence (0.0-1.0 decimal, NOT percentage), reasoning, assessed_at}\n" +
      "6. INSERT INTO strategist.regime_log (assessed_at, btc_price, btc_24h_change, eth_price, eth_24h_change, regime, trading_bias, confidence (0.0-1.0), reasoning)\n" +
      "7. Output ONLY the JSON (no extra text)"
  );

  const result = await runClaudeLocal(prompt, { timeoutMs: 3 * 60 * 1000 });

  if (result.error) {
    console.error(`[market-analysis] Failed: ${result.error}`);
    await sendDiscord(
      `Market analysis failed: ${result.error.substring(0, 200)}`
    );
    process.exit(1);
  }

  console.log(`[market-analysis] Completed in ${result.duration_ms}ms`);

  // Check if regime changed
  const newRegime = await readState<MarketRegimeState>("market-regime.json");

  if (newRegime && prevRegimeValue && newRegime.regime !== prevRegimeValue) {
    await sendDiscord(
      `Regime change: ${prevRegimeValue} -> ${newRegime.regime}\n` +
        `BTC: $${newRegime.btc_price?.toLocaleString()} (${newRegime.btc_24h_change >= 0 ? "+" : ""}${newRegime.btc_24h_change?.toFixed(2)}%)\n` +
        `ETH: $${newRegime.eth_price?.toLocaleString()} (${newRegime.eth_24h_change >= 0 ? "+" : ""}${newRegime.eth_24h_change?.toFixed(2)}%)\n` +
        `Bias: ${newRegime.trading_bias || "None"}`
    );
  }

  console.log(
    `[market-analysis] Regime: ${newRegime?.regime || "unknown"} | Done`
  );
}

main().catch((err) => {
  console.error("[market-analysis] Fatal:", err);
  process.exit(1);
});
