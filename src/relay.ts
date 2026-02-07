/**
 * Claude Master Strategist — Telegram Relay
 *
 * BTC/ETH-focused AI trading strategist running on CT100.
 * Connects Telegram to Claude Code CLI with full trading-signal-ai context.
 *
 * Commands:
 *   /status     — Quick state summary (no Claude spawn)
 *   /regime     — Force fresh regime analysis
 *   /performance — Force trade review
 *   /strategies — List all strategies with status
 *   /activate <id> — Activate a strategy for paper trading
 *   /research <desc> — SSH to CT110, backtest a strategy idea
 *
 * Plain messages → Claude CLI with enriched context
 *
 * Run: bun run src/relay.ts
 */

import { Bot, Context } from "grammy";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { buildPrompt, buildResearchPrompt } from "./helpers/prompt-builder";
import { runClaudeLocal, runClaudeRemote } from "./helpers/claude-runner";
import { sendTelegramChunked } from "./helpers/telegram";
import { readState, writeState } from "./helpers/state";
import type {
  MarketRegimeState,
  ActiveStrategiesState,
  PerformanceLogState,
  ResearchQueueState,
  ResearchRequest,
} from "./types";

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";

// src/ → up 1 = strategist/
const STRATEGIST_DIR = dirname(import.meta.dir);
const RELAY_DIR = join(STRATEGIST_DIR, ".relay");
const LOCK_FILE = join(RELAY_DIR, "bot.lock");
const LOGS_DIR = join(STRATEGIST_DIR, "logs");

// ============================================================
// LOCK FILE (prevent multiple instances)
// ============================================================

async function acquireLock(): Promise<boolean> {
  await mkdir(RELAY_DIR, { recursive: true });

  try {
    const existingLock = await readFile(LOCK_FILE, "utf-8").catch(() => null);

    if (existingLock) {
      const pid = parseInt(existingLock);
      try {
        process.kill(pid, 0);
        console.log(`Another instance running (PID: ${pid})`);
        return false;
      } catch {
        console.log("Stale lock found, taking over...");
      }
    }

    await writeFile(LOCK_FILE, process.pid.toString());
    return true;
  } catch (error) {
    console.error("Lock error:", error);
    return false;
  }
}

async function releaseLock(): Promise<void> {
  await unlink(LOCK_FILE).catch(() => {});
}

process.on("exit", () => {
  try {
    require("fs").unlinkSync(LOCK_FILE);
  } catch {}
});
process.on("SIGINT", async () => {
  await releaseLock();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await releaseLock();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. Create a new bot with /newbot");
  console.log("3. Copy the token to .env");
  process.exit(1);
}

// Create directories
await mkdir(RELAY_DIR, { recursive: true });
await mkdir(LOGS_DIR, { recursive: true });
await mkdir(join(STRATEGIST_DIR, "state"), { recursive: true });

// Acquire lock
if (!(await acquireLock())) {
  console.error("Could not acquire lock. Another instance may be running.");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// ============================================================
// SECURITY: Only respond to authorized user
// ============================================================

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id.toString();

  if (ALLOWED_USER_ID && userId !== ALLOWED_USER_ID) {
    console.log(`Unauthorized: ${userId}`);
    await ctx.reply("This bot is private.");
    return;
  }

  await next();
});

// ============================================================
// COMMAND HANDLERS
// ============================================================

/**
 * /status — Quick state summary (no Claude spawn, instant).
 */
bot.command("status", async (ctx) => {
  console.log("Command: /status");

  const regime = await readState<MarketRegimeState>("market-regime.json");
  const strategies =
    await readState<ActiveStrategiesState>("active-strategies.json");
  const perf = await readState<PerformanceLogState>("performance-log.json");

  const sections: string[] = ["*Master Strategist Status*\n"];

  if (regime) {
    const age = Math.round(
      (Date.now() - new Date(regime.assessed_at).getTime()) / 60000
    );
    sections.push(
      `*Market Regime:* ${regime.regime}` +
        `\nBTC: \`$${regime.btc_price?.toLocaleString()}\` (${regime.btc_24h_change >= 0 ? "+" : ""}${regime.btc_24h_change?.toFixed(2)}%)` +
        `\nETH: \`$${regime.eth_price?.toLocaleString()}\` (${regime.eth_24h_change >= 0 ? "+" : ""}${regime.eth_24h_change?.toFixed(2)}%)` +
        `\nUpdated: ${age}m ago\n`
    );
  } else {
    sections.push("*Market Regime:* Not yet assessed\n");
  }

  if (strategies && strategies.strategies.length > 0) {
    const active = strategies.strategies.filter(
      (s) => s.status === "paper" || s.status === "live"
    );
    sections.push(`*Active Strategies:* ${active.length}`);
    for (const s of active) {
      sections.push(`  ${s.strategy_id}: ${s.asset} ${s.direction} [${s.status}]`);
    }
    sections.push("");
  } else {
    sections.push("*Strategies:* None active\n");
  }

  if (perf && perf.total_trades > 0) {
    sections.push(
      `*Performance:*` +
        `\n  Trades: ${perf.total_trades} | Open: ${perf.open_positions}` +
        `\n  Win rate: ${perf.win_rate !== null ? (perf.win_rate * 100).toFixed(1) + "%" : "N/A"}` +
        `\n  P&L: ${perf.total_pnl_pct !== null ? (perf.total_pnl_pct >= 0 ? "+" : "") + perf.total_pnl_pct.toFixed(2) + "%" : "N/A"}`
    );
  } else {
    sections.push("*Performance:* No trades yet");
  }

  await ctx.reply(sections.join("\n"), { parse_mode: "Markdown" });
});

/**
 * /regime — Force fresh regime analysis via Claude.
 */
bot.command("regime", async (ctx) => {
  console.log("Command: /regime");
  await ctx.reply("Analyzing market regime...");
  await ctx.replyWithChatAction("typing");

  const prompt = await buildPrompt(
    "Fetch current BTC and ETH prices from the OHLCV service (localhost:8812, tickers BTC-USD and ETH-USD). " +
      "Calculate 24h change percentages. Determine regime (RALLY if BTC >+3%, SELLOFF if <-3%, NEUTRAL otherwise). " +
      "Assess trading bias for BTC and ETH. " +
      "Write results as JSON to strategist/state/market-regime.json with fields: regime, btc_price, btc_24h_change, eth_price, eth_24h_change, trading_bias, confidence, reasoning, assessed_at. " +
      "Also INSERT into strategist.regime_log table. " +
      "Then give a 2-3 sentence trading assessment."
  );

  const result = await runClaudeLocal(prompt);

  if (result.error) {
    await ctx.reply(`Regime analysis failed: ${result.error}`);
  } else {
    await sendResponse(ctx, result.output);
  }
});

/**
 * /performance — Force trade review via Claude.
 */
bot.command("performance", async (ctx) => {
  console.log("Command: /performance");
  await ctx.reply("Reviewing trading performance...");
  await ctx.replyWithChatAction("typing");

  const prompt = await buildPrompt(
    "Query strategist.positions for all recent trades. Calculate win rate, total P&L, and identify best/worst trades. " +
      "Write summary to strategist/state/performance-log.json. " +
      "Give a concise performance report with key insights."
  );

  const result = await runClaudeLocal(prompt);

  if (result.error) {
    await ctx.reply(`Performance review failed: ${result.error}`);
  } else {
    await sendResponse(ctx, result.output);
  }
});

/**
 * /strategies — List all strategies.
 */
bot.command("strategies", async (ctx) => {
  console.log("Command: /strategies");
  await ctx.reply("Fetching strategies...");
  await ctx.replyWithChatAction("typing");

  const prompt = await buildPrompt(
    "Query strategist.strategies table and list all strategies with their status, asset, direction, and last backtest results. " +
      "Format as a clean list. If no strategies exist, say so."
  );

  const result = await runClaudeLocal(prompt);

  if (result.error) {
    await ctx.reply(`Strategy query failed: ${result.error}`);
  } else {
    await sendResponse(ctx, result.output);
  }
});

/**
 * /activate <strategy-id> — Activate a strategy for paper trading.
 */
bot.command("activate", async (ctx) => {
  const strategyId = ctx.match?.trim();
  if (!strategyId) {
    await ctx.reply("Usage: /activate <strategy-id>\n\nUse /strategies to see available strategies.");
    return;
  }

  console.log(`Command: /activate ${strategyId}`);
  await ctx.reply(`Activating strategy: ${strategyId}...`);
  await ctx.replyWithChatAction("typing");

  const prompt = await buildPrompt(
    `Activate strategy '${strategyId}' for paper trading. ` +
      `UPDATE strategist.strategies SET status = 'paper', updated_at = NOW() WHERE strategy_id = '${strategyId}'. ` +
      `Then refresh strategist/state/active-strategies.json with all active strategies. ` +
      `Confirm activation with the strategy details.`
  );

  const result = await runClaudeLocal(prompt);

  if (result.error) {
    await ctx.reply(`Activation failed: ${result.error}`);
  } else {
    await sendResponse(ctx, result.output);
  }
});

/**
 * /research <description> — SSH to CT110, research + backtest strategy.
 */
bot.command("research", async (ctx) => {
  const description = ctx.match?.trim();
  if (!description) {
    await ctx.reply(
      "Usage: /research <strategy description>\n\n" +
        "Example: /research short ETH when RSI > 75 during SELLOFF regime"
    );
    return;
  }

  console.log(`Command: /research ${description}`);

  // Generate a branch name from the description
  const branchName =
    "strategy/" +
    description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .substring(0, 40);

  await ctx.reply(
    `Research request queued.\n` +
      `Branch: \`${branchName}\`\n` +
      `Deploying to CT110 (GPU)...\n\n` +
      `This may take 5-10 minutes. I'll notify you when done.`
  );

  // Run async — don't block the relay
  (async () => {
    try {
      const prompt = buildResearchPrompt(description);

      const result = await runClaudeRemote(prompt, {
        branch: branchName,
        timeoutMs: 10 * 60 * 1000, // 10 minutes for research
      });

      if (result.error) {
        await sendTelegramChunked(
          `Research failed for "${description}":\n${result.error}`
        );
      } else {
        await sendTelegramChunked(
          `Research complete for "${description}":\n\n${result.output}`
        );
      }
    } catch (error) {
      const errMsg =
        error instanceof Error ? error.message : "Unknown error";
      await sendTelegramChunked(`Research error: ${errMsg}`);
    }
  })();
});

/**
 * /help — Show available commands.
 */
bot.command("help", async (ctx) => {
  await ctx.reply(
    `*Claude Master Strategist*\n\n` +
      `*Commands:*\n` +
      `/status — Quick status (instant, no Claude)\n` +
      `/regime — Fresh regime analysis\n` +
      `/performance — Trade review\n` +
      `/strategies — List all strategies\n` +
      `/activate <id> — Activate strategy for paper trading\n` +
      `/research <desc> — Research & backtest on CT110\n` +
      `/help — This message\n\n` +
      `Or just send a message to chat about BTC/ETH trading.`,
    { parse_mode: "Markdown" }
  );
});

// ============================================================
// GENERAL MESSAGE HANDLER
// ============================================================

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;

  // Skip if it was a command (already handled above)
  if (text.startsWith("/")) return;

  console.log(`Message: ${text.substring(0, 80)}...`);

  await ctx.replyWithChatAction("typing");

  // Send "thinking" indicator for long waits
  const thinkingTimeout = setTimeout(async () => {
    try {
      await ctx.reply("Thinking...");
    } catch {}
  }, 15000);

  const prompt = await buildPrompt(text);
  const result = await runClaudeLocal(prompt);

  clearTimeout(thinkingTimeout);

  if (result.error) {
    await ctx.reply(`Error: ${result.error}`);
  } else {
    await sendResponse(ctx, result.output);
  }
});

// ============================================================
// PHOTO HANDLER (chart analysis)
// ============================================================

bot.on("message:photo", async (ctx) => {
  console.log("Image received");
  await ctx.replyWithChatAction("typing");

  try {
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);

    const timestamp = Date.now();
    const uploadsDir = join(STRATEGIST_DIR, "uploads");
    await mkdir(uploadsDir, { recursive: true });
    const filePath = join(uploadsDir, `chart_${timestamp}.jpg`);

    const response = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`
    );
    const buffer = await response.arrayBuffer();
    await writeFile(filePath, Buffer.from(buffer));

    const caption = ctx.message.caption || "Analyze this chart in the context of our BTC/ETH trading strategy.";
    const prompt = await buildPrompt(`[Image: ${filePath}]\n\n${caption}`);

    const claudeResult = await runClaudeLocal(prompt);

    await unlink(filePath).catch(() => {});

    if (claudeResult.error) {
      await ctx.reply(`Image analysis failed: ${claudeResult.error}`);
    } else {
      await sendResponse(ctx, claudeResult.output);
    }
  } catch (error) {
    console.error("Image error:", error);
    await ctx.reply("Could not process image.");
  }
});

// ============================================================
// HELPERS
// ============================================================

async function sendResponse(ctx: Context, response: string): Promise<void> {
  const MAX_LENGTH = 4000;

  if (response.length <= MAX_LENGTH) {
    await ctx.reply(response);
    return;
  }

  const chunks: string[] = [];
  let remaining = response;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n\n", MAX_LENGTH);
    if (splitIndex === -1)
      splitIndex = remaining.lastIndexOf("\n", MAX_LENGTH);
    if (splitIndex === -1)
      splitIndex = remaining.lastIndexOf(" ", MAX_LENGTH);
    if (splitIndex === -1) splitIndex = MAX_LENGTH;

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
}

// ============================================================
// START
// ============================================================

console.log("Starting Claude Master Strategist...");
console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
console.log(`Focus: BTC + ETH on Hyperliquid`);

bot.start({
  onStart: () => {
    console.log("Bot is running!");
  },
});
