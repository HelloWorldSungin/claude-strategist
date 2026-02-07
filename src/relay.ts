/**
 * Claude Master Strategist — Discord Relay
 *
 * BTC/ETH-focused AI trading strategist running on CT100.
 * Connects Discord to Claude Code CLI with full trading-signal-ai context.
 *
 * Slash Commands:
 *   /status     — Quick state summary (no Claude spawn)
 *   /regime     — Force fresh regime analysis
 *   /performance — Force trade review
 *   /strategies — List all strategies with status
 *   /activate <id> — Activate a strategy for paper trading
 *   /research <desc> — SSH to CT110, backtest a strategy idea
 *   /ask <question> — Ask Claude anything
 *   /help       — Show available commands
 *
 * Plain messages in configured channel → Claude CLI with enriched context
 *
 * Run: bun run src/relay.ts
 */

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { writeFile, mkdir, readFile, unlink } from "fs/promises";
import { join, dirname } from "path";
import { buildPrompt, buildResearchPrompt } from "./helpers/prompt-builder";
import { runClaudeLocal, runClaudeRemote } from "./helpers/claude-runner";
import { sendDiscordChunked } from "./helpers/discord";
import { readState, writeState } from "./helpers/state";
import { logConversation, getStrategy, activateStrategy, closePool } from "./helpers/db";
import type {
  MarketRegimeState,
  ActiveStrategiesState,
  PerformanceLogState,
} from "./types";

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.DISCORD_USER_ID || "";
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || "";

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
  await closePool();
  client.destroy();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await releaseLock();
  await closePool();
  client.destroy();
  process.exit(0);
});

// ============================================================
// SETUP
// ============================================================

if (!BOT_TOKEN) {
  console.error("DISCORD_BOT_TOKEN not set!");
  console.log("\nTo set up:");
  console.log("1. Go to https://discord.com/developers/applications");
  console.log("2. Create a new application");
  console.log("3. Go to Bot tab → Reset Token → copy to .env");
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

// ============================================================
// SLASH COMMAND DEFINITIONS
// ============================================================

const commands = [
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Quick state summary (instant, no Claude)"),
  new SlashCommandBuilder()
    .setName("regime")
    .setDescription("Force fresh regime analysis via Claude"),
  new SlashCommandBuilder()
    .setName("performance")
    .setDescription("Force trade performance review via Claude"),
  new SlashCommandBuilder()
    .setName("strategies")
    .setDescription("List all strategies with status"),
  new SlashCommandBuilder()
    .setName("activate")
    .setDescription("Activate a strategy for paper trading")
    .addStringOption((opt) =>
      opt
        .setName("strategy_id")
        .setDescription("The strategy ID to activate")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("research")
    .setDescription("Research & backtest a strategy idea on CT110")
    .addStringOption((opt) =>
      opt
        .setName("description")
        .setDescription("Strategy description to research")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Ask Claude anything about BTC/ETH trading")
    .addStringOption((opt) =>
      opt
        .setName("question")
        .setDescription("Your question")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show available commands"),
];

// ============================================================
// DISCORD CLIENT
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ============================================================
// SECURITY: Check authorized user (fail-closed)
// ============================================================

function isAuthorized(userId: string): boolean {
  if (!ALLOWED_USER_ID) {
    throw new Error("DISCORD_USER_ID not set — refusing all requests (fail-closed)");
  }
  return userId === ALLOWED_USER_ID;
}

// ============================================================
// INPUT VALIDATION
// ============================================================

const STRATEGY_ID_RE = /^[a-zA-Z0-9_-]{1,50}$/;

function validateStrategyId(id: string): string | null {
  if (!STRATEGY_ID_RE.test(id)) {
    return "Invalid strategy_id. Use only letters, numbers, hyphens, underscores (max 50 chars).";
  }
  return null;
}

function validateTextInput(text: string, maxLen: number, fieldName: string): string | null {
  if (text.length > maxLen) {
    return `${fieldName} too long (max ${maxLen} chars, got ${text.length}).`;
  }
  return null;
}

// ============================================================
// RATE LIMITING: Sliding window for Claude spawns
// ============================================================

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;
const claudeSpawnTimestamps: number[] = [];

function checkRateLimit(): boolean {
  const now = Date.now();
  // Remove expired entries
  while (claudeSpawnTimestamps.length > 0 && claudeSpawnTimestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
    claudeSpawnTimestamps.shift();
  }
  if (claudeSpawnTimestamps.length >= RATE_LIMIT_MAX) {
    return false;
  }
  claudeSpawnTimestamps.push(now);
  return true;
}

// ============================================================
// RESEARCH QUEUE DEPTH LIMIT
// ============================================================

let activeResearchCount = 0;

// ============================================================
// HELPERS
// ============================================================

const MAX_LENGTH = 1900;

/**
 * Split a long response into Discord-friendly chunks and send them.
 */
async function sendChunkedReply(
  interaction: ChatInputCommandInteraction,
  response: string
): Promise<void> {
  if (!response || response.trim().length === 0) {
    await interaction.editReply("Task completed (no text output from Claude).");
    return;
  }

  if (response.length <= MAX_LENGTH) {
    await interaction.editReply(response);
    return;
  }

  // First chunk goes to editReply
  const chunks = splitMessage(response);
  await interaction.editReply(chunks[0]);

  // Remaining chunks as follow-up messages
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp(chunks[i]);
  }
}

/**
 * Split a long message into chunks at natural boundaries.
 */
function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;

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

  return chunks;
}

/**
 * Send a long message as multiple channel messages (for plain text handler).
 */
async function sendChannelChunked(
  message: Message,
  response: string
): Promise<void> {
  if (!response || response.trim().length === 0) {
    await message.reply("Task completed (no text output from Claude).");
    return;
  }

  const chunks = splitMessage(response);
  await message.reply(chunks[0]);

  for (let i = 1; i < chunks.length; i++) {
    await message.channel.send(chunks[i]);
  }
}

// ============================================================
// EVENT: Ready — register slash commands
// ============================================================

client.once("ready", async () => {
  console.log(`Logged in as ${client.user?.tag}`);

  // Register slash commands globally
  try {
    await client.application!.commands.set(
      commands.map((c) => c.toJSON())
    );
    console.log("Slash commands registered");
  } catch (error) {
    console.error("Failed to register slash commands:", error);
  }

  console.log(`Authorized user: ${ALLOWED_USER_ID || "ANY (not recommended)"}`);
  console.log(`Channel: ${CHANNEL_ID || "ANY"}`);
  console.log("Focus: BTC + ETH on Hyperliquid");
  console.log("Bot is running!");
});

// ============================================================
// EVENT: Slash command interactions
// ============================================================

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!isAuthorized(interaction.user.id)) {
    await interaction.reply({
      content: "This bot is private.",
      ephemeral: true,
    });
    return;
  }

  const { commandName } = interaction;

  try {
    switch (commandName) {
      case "status":
        await handleStatus(interaction);
        break;
      case "regime":
        await handleRegime(interaction);
        break;
      case "performance":
        await handlePerformance(interaction);
        break;
      case "strategies":
        await handleStrategies(interaction);
        break;
      case "activate":
        await handleActivate(interaction);
        break;
      case "research":
        await handleResearch(interaction);
        break;
      case "ask":
        await handleAsk(interaction);
        break;
      case "help":
        await handleHelp(interaction);
        break;
    }
  } catch (error) {
    console.error(`Command error (/${commandName}):`, error);
    const errMsg =
      error instanceof Error ? error.message : "Unknown error";
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(`Error: ${errMsg}`);
      } else {
        await interaction.reply(`Error: ${errMsg}`);
      }
    } catch {}
  }
});

// ============================================================
// COMMAND HANDLERS
// ============================================================

/**
 * /status — Quick state summary (no Claude spawn, instant).
 */
async function handleStatus(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  console.log("Command: /status");

  const regime = await readState<MarketRegimeState>("market-regime.json");
  const strategies =
    await readState<ActiveStrategiesState>("active-strategies.json");
  const perf = await readState<PerformanceLogState>("performance-log.json");

  const sections: string[] = ["**Master Strategist Status**\n"];

  if (regime) {
    const age = Math.round(
      (Date.now() - new Date(regime.assessed_at).getTime()) / 60000
    );
    sections.push(
      `**Market Regime:** ${regime.regime}` +
        `\nBTC: \`$${regime.btc_price?.toLocaleString()}\` (${regime.btc_24h_change >= 0 ? "+" : ""}${regime.btc_24h_change?.toFixed(2)}%)` +
        `\nETH: \`$${regime.eth_price?.toLocaleString()}\` (${regime.eth_24h_change >= 0 ? "+" : ""}${regime.eth_24h_change?.toFixed(2)}%)` +
        `\nUpdated: ${age}m ago\n`
    );
  } else {
    sections.push("**Market Regime:** Not yet assessed\n");
  }

  if (strategies && strategies.strategies.length > 0) {
    const active = strategies.strategies.filter(
      (s) => s.status === "paper" || s.status === "live"
    );
    sections.push(`**Active Strategies:** ${active.length}`);
    for (const s of active) {
      sections.push(
        `  ${s.strategy_id}: ${s.asset} ${s.direction} [${s.status}]`
      );
    }
    sections.push("");
  } else {
    sections.push("**Strategies:** None active\n");
  }

  if (perf && perf.total_trades > 0) {
    sections.push(
      `**Performance:**` +
        `\n  Trades: ${perf.total_trades} | Open: ${perf.open_positions}` +
        `\n  Win rate: ${perf.win_rate !== null ? (perf.win_rate * 100).toFixed(1) + "%" : "N/A"}` +
        `\n  P&L: ${perf.total_pnl_pct !== null ? (perf.total_pnl_pct >= 0 ? "+" : "") + perf.total_pnl_pct.toFixed(2) + "%" : "N/A"}`
    );
  } else {
    sections.push("**Performance:** No trades yet");
  }

  await interaction.reply(sections.join("\n"));
}

/**
 * /regime — Force fresh regime analysis via Claude.
 */
async function handleRegime(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!checkRateLimit()) {
    await interaction.reply({
      content: "Rate limited — too many Claude requests. Try again in a minute.",
      ephemeral: true,
    });
    return;
  }

  console.log("Command: /regime");
  await logConversation({
    role: "user",
    content: "/regime",
    command: "/regime",
  });
  await interaction.deferReply();

  const prompt = await buildPrompt(
    "Fetch current BTC and ETH prices from the OHLCV service (localhost:8812, tickers BTC-USD and ETH-USD). " +
      "Calculate 24h change percentages. Determine regime (RALLY if BTC >+3%, SELLOFF if <-3%, NEUTRAL otherwise). " +
      "Assess trading bias for BTC and ETH. " +
      "Write results as JSON to strategist/state/market-regime.json with fields: regime, btc_price, btc_24h_change, eth_price, eth_24h_change, trading_bias, confidence (0.0-1.0 range), reasoning, assessed_at. " +
      "Also INSERT into strategist.regime_log table (confidence as 0.0-1.0 decimal, not percentage). " +
      "Then give a 2-3 sentence trading assessment."
  );

  const result = await runClaudeLocal(prompt);

  if (result.error) {
    await interaction.editReply(`Regime analysis failed: ${result.error}`);
  } else {
    await logConversation({
      role: "assistant",
      content: result.output,
      command: "/regime",
      duration_ms: result.duration_ms,
    });
    await sendChunkedReply(interaction, result.output);
  }
}

/**
 * /performance — Force trade review via Claude.
 */
async function handlePerformance(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!checkRateLimit()) {
    await interaction.reply({
      content: "Rate limited — too many Claude requests. Try again in a minute.",
      ephemeral: true,
    });
    return;
  }

  console.log("Command: /performance");
  await logConversation({
    role: "user",
    content: "/performance",
    command: "/performance",
  });
  await interaction.deferReply();

  const prompt = await buildPrompt(
    "Query strategist.positions for all recent trades. Calculate win rate, total P&L, and identify best/worst trades. " +
      "Write summary to strategist/state/performance-log.json. " +
      "Give a concise performance report with key insights."
  );

  const result = await runClaudeLocal(prompt);

  if (result.error) {
    await interaction.editReply(`Performance review failed: ${result.error}`);
  } else {
    await logConversation({
      role: "assistant",
      content: result.output,
      command: "/performance",
      duration_ms: result.duration_ms,
    });
    await sendChunkedReply(interaction, result.output);
  }
}

/**
 * /strategies — List all strategies.
 */
async function handleStrategies(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!checkRateLimit()) {
    await interaction.reply({
      content: "Rate limited — too many Claude requests. Try again in a minute.",
      ephemeral: true,
    });
    return;
  }

  console.log("Command: /strategies");
  await logConversation({
    role: "user",
    content: "/strategies",
    command: "/strategies",
  });
  await interaction.deferReply();

  const prompt = await buildPrompt(
    "Query strategist.strategies table and list all strategies with their status, asset, direction, and last backtest results. " +
      "Format as a clean list. If no strategies exist, say so."
  );

  const result = await runClaudeLocal(prompt);

  if (result.error) {
    await interaction.editReply(`Strategy query failed: ${result.error}`);
  } else {
    await logConversation({
      role: "assistant",
      content: result.output,
      command: "/strategies",
      duration_ms: result.duration_ms,
    });
    await sendChunkedReply(interaction, result.output);
  }
}

/**
 * /activate <strategy_id> — Activate a strategy for paper trading.
 * Pre-validates strategy existence, status, and backtest quality.
 */
async function handleActivate(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const strategyId = interaction.options.getString("strategy_id", true);

  const idError = validateStrategyId(strategyId);
  if (idError) {
    await interaction.reply({ content: idError, ephemeral: true });
    return;
  }

  if (!checkRateLimit()) {
    await interaction.reply({
      content: "Rate limited — too many Claude requests. Try again in a minute.",
      ephemeral: true,
    });
    return;
  }

  console.log(`Command: /activate ${strategyId}`);
  await logConversation({
    role: "user",
    content: `/activate ${strategyId}`,
    command: "/activate",
  });
  await interaction.deferReply();

  // Pre-activation validation
  const strategy = await getStrategy(strategyId);

  if (!strategy) {
    await interaction.editReply(
      `Strategy \`${strategyId}\` not found. Use /strategies to see available strategies.`
    );
    return;
  }

  if (strategy.status === "paper" || strategy.status === "live") {
    await interaction.editReply(
      `Strategy \`${strategyId}\` is already active (status: ${strategy.status}).`
    );
    return;
  }

  if (!strategy.backtest_results) {
    await interaction.editReply(
      `Strategy \`${strategyId}\` has no backtest results. Run \`/research\` first to validate it.`
    );
    return;
  }

  // Check backtest quality
  let qualityWarning = "";
  try {
    const bt = JSON.parse(strategy.backtest_results);
    const winRate = bt.win_rate ?? bt.winRate ?? null;
    const sharpe = bt.sharpe ?? bt.sharpe_ratio ?? null;
    const warnings: string[] = [];
    if (winRate !== null && winRate < 0.52) {
      warnings.push(`win rate ${(winRate * 100).toFixed(1)}% (< 52%)`);
    }
    if (sharpe !== null && sharpe < 0.5) {
      warnings.push(`Sharpe ${sharpe.toFixed(2)} (< 0.5)`);
    }
    if (warnings.length > 0) {
      qualityWarning =
        ` Note: activating despite poor backtest metrics — ${warnings.join(", ")}.`;
    }
  } catch {
    // backtest_results wasn't valid JSON — proceed anyway
  }

  // Activate directly via parameterized query — never pass SQL to Claude
  await activateStrategy(strategyId);

  const prompt = await buildPrompt(
    `Strategy '${strategyId}' has been activated for paper trading.${qualityWarning} ` +
      `Refresh strategist/state/active-strategies.json with all active strategies from the DB. ` +
      `Confirm activation with the strategy details.`
  );

  const result = await runClaudeLocal(prompt);

  if (result.error) {
    await interaction.editReply(`Activation failed: ${result.error}`);
  } else {
    await logConversation({
      role: "assistant",
      content: result.output,
      command: "/activate",
      duration_ms: result.duration_ms,
    });
    await sendChunkedReply(interaction, result.output);
  }
}

/**
 * /research <description> — SSH to CT110, research + backtest strategy.
 */
async function handleResearch(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const description = interaction.options.getString("description", true);

  const descError = validateTextInput(description, 500, "Description");
  if (descError) {
    await interaction.reply({ content: descError, ephemeral: true });
    return;
  }

  if (activeResearchCount >= 1) {
    await interaction.reply({
      content: "Research already in progress. Please wait for it to complete.",
      ephemeral: true,
    });
    return;
  }

  // Claim the research slot immediately to prevent TOCTOU race
  activeResearchCount++;

  try {
    if (!checkRateLimit()) {
      await interaction.reply({
        content: "Rate limited — too many Claude requests. Try again in a minute.",
        ephemeral: true,
      });
      activeResearchCount--;
      return;
    }

    console.log(`Command: /research ${description}`);
    await logConversation({
      role: "user",
      content: `/research ${description}`,
      command: "/research",
    });

    // Generate a branch name from the description
    const branchName =
      "strategy/" +
      description
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .substring(0, 40);

    await interaction.reply(
      `Research request queued.\n` +
        `Branch: \`${branchName}\`\n` +
        `Deploying to CT110 (GPU)...\n\n` +
        `This may take 5-10 minutes. I'll notify you when done.`
    );

    // Run async — don't block the relay
    // Note: activeResearchCount is already incremented; the async block owns the decrement
    (async () => {
      try {
        const prompt = buildResearchPrompt(description);

        const result = await runClaudeRemote(prompt, {
          branch: branchName,
          timeoutMs: 10 * 60 * 1000,
        });

        if (result.error) {
          await sendDiscordChunked(
            `Research failed for "${description}":\n${result.error}`
          );
        } else {
          await sendDiscordChunked(
            `Research complete for "${description}":\n\n${result.output}`
          );
        }
      } catch (error) {
        const errMsg =
          error instanceof Error ? error.message : "Unknown error";
        await sendDiscordChunked(`Research error: ${errMsg}`);
      } finally {
        activeResearchCount--;
      }
    })();
  } catch (err) {
    activeResearchCount--;
    throw err;
  }
}

/**
 * /ask <question> — Ask Claude anything about BTC/ETH trading.
 */
async function handleAsk(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const question = interaction.options.getString("question", true);

  const qError = validateTextInput(question, 2000, "Question");
  if (qError) {
    await interaction.reply({ content: qError, ephemeral: true });
    return;
  }

  if (!checkRateLimit()) {
    await interaction.reply({
      content: "Rate limited — too many Claude requests. Try again in a minute.",
      ephemeral: true,
    });
    return;
  }

  console.log(`Command: /ask ${question.substring(0, 80)}`);
  await logConversation({
    role: "user",
    content: `/ask ${question}`,
    command: "/ask",
  });
  await interaction.deferReply();

  const prompt = await buildPrompt(question);
  const result = await runClaudeLocal(prompt);

  if (result.error) {
    await interaction.editReply(`Error: ${result.error}`);
  } else {
    await logConversation({
      role: "assistant",
      content: result.output,
      command: "/ask",
      duration_ms: result.duration_ms,
    });
    await sendChunkedReply(interaction, result.output);
  }
}

/**
 * /help — Show available commands.
 */
async function handleHelp(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  await interaction.reply(
    `**Claude Master Strategist**\n\n` +
      `**Commands:**\n` +
      `/status — Quick status (instant, no Claude)\n` +
      `/regime — Fresh regime analysis\n` +
      `/performance — Trade review\n` +
      `/strategies — List all strategies\n` +
      `/activate — Activate strategy for paper trading\n` +
      `/research — Research & backtest on CT110\n` +
      `/ask — Ask Claude anything\n` +
      `/help — This message\n\n` +
      `Or just send a message in the channel to chat about BTC/ETH trading.`
  );
}

// ============================================================
// EVENT: Plain text messages in configured channel
// ============================================================

client.on("messageCreate", async (message: Message) => {
  // Ignore bot's own messages
  if (message.author.id === client.user?.id) return;
  // Ignore other bots
  if (message.author.bot) return;
  // Check authorized user
  if (!isAuthorized(message.author.id)) return;
  // Check configured channel (if set)
  if (CHANNEL_ID && message.channel.id !== CHANNEL_ID) return;

  // Handle image attachments
  const imageAttachment = message.attachments.find((a) =>
    a.contentType?.startsWith("image/")
  );

  if (imageAttachment) {
    console.log("Image received");

    try {
      const timestamp = Date.now();
      const uploadsDir = join(STRATEGIST_DIR, "uploads");
      await mkdir(uploadsDir, { recursive: true });
      const ext = imageAttachment.contentType?.split("/")[1] || "png";
      const filePath = join(uploadsDir, `chart_${timestamp}.${ext}`);

      const response = await fetch(imageAttachment.url);
      const buffer = await response.arrayBuffer();
      await writeFile(filePath, Buffer.from(buffer));

      const caption =
        message.content ||
        "Analyze this chart in the context of our BTC/ETH trading strategy.";
      const prompt = await buildPrompt(`[Image: ${filePath}]\n\n${caption}`);

      await message.channel.sendTyping();
      const claudeResult = await runClaudeLocal(prompt);

      await unlink(filePath).catch(() => {});

      if (claudeResult.error) {
        await message.reply(`Image analysis failed: ${claudeResult.error}`);
      } else {
        await sendChannelChunked(message, claudeResult.output);
      }
    } catch (error) {
      console.error("Image error:", error);
      await message.reply("Could not process image.");
    }
    return;
  }

  // Handle plain text
  const text = message.content;
  if (!text || text.trim().length === 0) return;

  const msgError = validateTextInput(text, 2000, "Message");
  if (msgError) {
    await message.reply(msgError);
    return;
  }

  if (!checkRateLimit()) {
    await message.reply("Rate limited — too many Claude requests. Try again in a minute.");
    return;
  }

  console.log(`Message: ${text.substring(0, 80)}...`);
  await logConversation({ role: "user", content: text });

  await message.channel.sendTyping();

  // Repeat typing indicator every 8 seconds (Discord typing expires after 10s)
  const typingInterval = setInterval(async () => {
    try {
      await message.channel.sendTyping();
    } catch {}
  }, 8000);

  const prompt = await buildPrompt(text);
  const result = await runClaudeLocal(prompt);

  clearInterval(typingInterval);

  if (result.error) {
    await message.reply(`Error: ${result.error}`);
  } else {
    await logConversation({
      role: "assistant",
      content: result.output,
      duration_ms: result.duration_ms,
    });
    await sendChannelChunked(message, result.output);
  }
});

// ============================================================
// START
// ============================================================

console.log("Starting Claude Master Strategist (Discord)...");

client.login(BOT_TOKEN);
