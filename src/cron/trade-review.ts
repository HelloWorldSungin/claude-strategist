/**
 * Trade Review Cron Job
 *
 * Runs every 6 hours. Spawns Claude to review recent trades,
 * calculate performance metrics, and write state/performance-log.json.
 * Sends Discord summary for notable findings.
 *
 * Schedule: 30 */6 * * *
 */

import { buildCronPrompt } from "../helpers/prompt-builder";
import { runClaudeLocal } from "../helpers/claude-runner";
import { sendDiscord } from "../helpers/discord";

async function main() {
  console.log(`[trade-review] Starting at ${new Date().toISOString()}`);

  const prompt = await buildCronPrompt(
    "Trade performance review.\n\n" +
      "1. Query strategist.positions for all trades (open and closed)\n" +
      "2. Calculate: total trades, win rate, total P&L %, best trade, worst trade\n" +
      "3. Count open positions and their current unrealized P&L\n" +
      "4. Identify any notable patterns (e.g., 'shorts performing better in current regime')\n" +
      "5. Write JSON to strategist/state/performance-log.json:\n" +
      "   {total_trades, open_positions, win_rate, total_pnl_pct, recent_trades, summary, reviewed_at}\n" +
      "6. If there are notable findings (big win, big loss, regime mismatch), output a 2-3 sentence summary\n" +
      "7. If no trades exist yet, write empty defaults and say 'No trades to review'"
  );

  const result = await runClaudeLocal(prompt, { timeoutMs: 3 * 60 * 1000 });

  if (result.error) {
    console.error(`[trade-review] Failed: ${result.error}`);
    await sendDiscord(
      `Trade review failed: ${result.error.substring(0, 200)}`
    );
    process.exit(1);
  }

  console.log(`[trade-review] Completed in ${result.duration_ms}ms`);

  // Send summary if there's meaningful output
  const output = result.output.trim();
  if (
    output.length > 10 &&
    !output.toLowerCase().includes("no trades to review")
  ) {
    // Truncate to Discord-friendly length
    const summary =
      output.length > 1800 ? output.substring(0, 1800) + "..." : output;
    await sendDiscord(`Trade Review:\n${summary}`);
  }

  console.log("[trade-review] Done");
}

main().catch((err) => {
  console.error("[trade-review] Fatal:", err);
  process.exit(1);
});
