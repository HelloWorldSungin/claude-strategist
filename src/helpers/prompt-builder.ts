/**
 * Builds enriched prompts for Claude with current market context.
 *
 * Reads state files and injects regime, strategies, and performance
 * context so Claude has full situational awareness despite stateless spawns.
 */

import { readState } from "./state";
import { getRecentConversations } from "./db";
import type {
  MarketRegimeState,
  ActiveStrategiesState,
  PerformanceLogState,
} from "../types";

const SYSTEM_IDENTITY = `You are the Master Strategist — an AI trading advisor focused exclusively on BTC and ETH on Hyperliquid.

Your communication style:
- Concise, actionable, data-driven
- Use Telegram-friendly formatting (bold, monospace for numbers)
- Always cite specific prices, percentages, and timeframes
- Think probabilistically — express conviction as confidence levels
- You have access to the full trading-signal-ai codebase, OHLCV service (localhost:8812), and PostgreSQL (strategist schema)

Your tools:
- OHLCV data: fetch via Python using src.ohlcv_service.client (tickers: BTC-USD, ETH-USD)
- Database: query strategist.* tables on CT120 (DATABASE_URL in env)
- Regime filter: src.utils.regime_filter for BTC regime detection
- Write state: write JSON files to strategist/state/ directory for caching`;

/**
 * Build the main system prompt with current context.
 */
export async function buildPrompt(userMessage: string): Promise<string> {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const sections: string[] = [SYSTEM_IDENTITY, `Current time: ${timeStr}`];

  // Inject market regime context
  const regime = await readState<MarketRegimeState>("market-regime.json");
  if (regime) {
    sections.push(
      `\nCurrent Market Regime (as of ${regime.assessed_at}):` +
        `\n  Regime: ${regime.regime}` +
        `\n  BTC: $${regime.btc_price?.toLocaleString()} (${regime.btc_24h_change >= 0 ? "+" : ""}${regime.btc_24h_change?.toFixed(2)}% 24h)` +
        `\n  ETH: $${regime.eth_price?.toLocaleString()} (${regime.eth_24h_change >= 0 ? "+" : ""}${regime.eth_24h_change?.toFixed(2)}% 24h)` +
        `\n  Bias: ${regime.trading_bias || "None"}` +
        `\n  Confidence: ${(((regime.confidence || 0) > 1 ? (regime.confidence || 0) / 100 : (regime.confidence || 0)) * 100).toFixed(0)}%`
    );
  }

  // Inject active strategies context
  const strategies =
    await readState<ActiveStrategiesState>("active-strategies.json");
  if (strategies && strategies.strategies.length > 0) {
    const stratList = strategies.strategies
      .map(
        (s) =>
          `  - ${s.strategy_id}: ${s.name} [${s.asset} ${s.direction}] (${s.status})${s.regime_condition ? ` — requires ${s.regime_condition}` : ""}`
      )
      .join("\n");
    sections.push(`\nActive Strategies:\n${stratList}`);
  } else {
    sections.push(
      "\nNo active strategies yet. User is starting fresh with BTC+ETH focus."
    );
  }

  // Inject recent performance
  const perf = await readState<PerformanceLogState>("performance-log.json");
  if (perf && perf.total_trades > 0) {
    sections.push(
      `\nRecent Performance (as of ${perf.reviewed_at}):` +
        `\n  Total trades: ${perf.total_trades}` +
        `\n  Open positions: ${perf.open_positions}` +
        `\n  Win rate: ${perf.win_rate !== null ? (perf.win_rate * 100).toFixed(1) + "%" : "N/A"}` +
        `\n  Total P&L: ${perf.total_pnl_pct !== null ? (perf.total_pnl_pct >= 0 ? "+" : "") + perf.total_pnl_pct.toFixed(2) + "%" : "N/A"}`
    );
  }

  // Inject recent conversation history for continuity
  const recentConvos = await getRecentConversations(10);
  if (recentConvos.length > 0) {
    const history = recentConvos
      .reverse() // chronological order
      .map((c) => `${c.role === "user" ? "User" : "Assistant"}: ${c.content.substring(0, 500)}`)
      .join("\n");
    sections.push(`\nRecent conversation:\n${history}`);
  }

  // Add user message
  sections.push(`\nUser message: ${userMessage}`);

  return sections.join("\n");
}

/**
 * Build a cron prompt (no user message, just task description).
 */
export async function buildCronPrompt(task: string): Promise<string> {
  const now = new Date();
  const timeStr = now.toISOString();

  const sections: string[] = [
    SYSTEM_IDENTITY,
    `Current time: ${timeStr}`,
    `\nAutomated task: ${task}`,
  ];

  // Include regime for context
  const regime = await readState<MarketRegimeState>("market-regime.json");
  if (regime) {
    sections.push(
      `\nPrevious regime assessment (${regime.assessed_at}): ${regime.regime}` +
        ` | BTC $${regime.btc_price?.toLocaleString()} (${regime.btc_24h_change >= 0 ? "+" : ""}${regime.btc_24h_change?.toFixed(2)}%)`
    );
  }

  return sections.join("\n");
}

/**
 * Build a research prompt for CT110.
 */
export function buildResearchPrompt(description: string): string {
  return `${SYSTEM_IDENTITY}

You are running on CT110 (research container) with GPU access.
Your task: Research and backtest a trading strategy.

Strategy description: ${description}

Instructions:
1. Design the strategy with specific entry/exit rules for BTC and/or ETH
2. Write a Python backtest script using the existing src/backtesting/ framework
3. Fetch OHLCV data via src.ohlcv_service.client (BTC-USD, ETH-USD)
4. Run walk-forward validation (at least 3 rolling windows)
5. Calculate: win rate, Sharpe ratio, max drawdown, profit factor
6. Store the strategy definition in the strategist.strategies table:
   INSERT INTO strategist.strategies (strategy_id, name, asset, direction, description, entry_rules, exit_rules, regime_condition, parameters, status, backtest_results)
   VALUES (...)
7. If backtest passes (win rate > 52%, Sharpe > 0.5), push the branch and create a PR
8. Output a JSON summary of results at the end

Focus on BTC and ETH only. Use 1h candles as primary timeframe.`;
}
