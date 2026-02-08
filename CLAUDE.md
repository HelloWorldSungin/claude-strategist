# CLAUDE.md — Strategist Submodule

Claude Code guidance for the Claude Master Strategist Discord bot.

## Overview

A Bun/TypeScript Discord bot that connects slash commands and plain messages to Claude Code CLI, providing AI-powered BTC/ETH trading strategy management. Runs as a systemd service on CT100.

## Architecture

```
Discord User ─── /command or message ──▶ relay.ts (discord.js)
                                              │
                                              ▼
                                     prompt-builder.ts (enrich with context)
                                              │
                                    ┌─────────┴──────────┐
                                    ▼                    ▼
                           claude-runner.ts       claude-runner.ts
                           (local, CT100)         (remote, CT110 via SSH)
                                    │                    │
                                    ▼                    ▼
                              Claude CLI            Claude CLI
                           (trading-signal-ai)    (GPU research)
```

**Key files:**
- `src/relay.ts` — Discord bot entry point, 8 slash commands, plain text handler
- `src/helpers/prompt-builder.ts` — Enriches prompts with regime, strategies, performance, memory, conversation history
- `src/helpers/claude-runner.ts` — Spawns Claude CLI locally (CT100) or remotely (CT110 via SSH)
- `src/helpers/db.ts` — PostgreSQL via `pg` driver (parameterized queries only)
- `src/helpers/state.ts` — Atomic JSON state file read/write (local cache, DB is source of truth)
- `src/helpers/discord.ts` — Webhook helpers for cron notifications
- `src/helpers/retry.ts` — Exponential backoff for transient errors
- `src/types.ts` — TypeScript interfaces for state schemas and DB records

**Cron jobs (independent of bot):**
- `src/cron/market-analysis.ts` — Regime assessment every 2h
- `src/cron/trade-review.ts` — Performance review every 6h
- `src/cron/strategy-watchdog.ts` — Health checks every 1h (no Claude spawn)

## Security Conventions

**These are non-negotiable. Every change must follow these rules.**

1. **Parameterized SQL only** — All queries use `$1, $2, ...` placeholders via the `pg` driver. Never interpolate user input into SQL strings.
2. **Fail-closed authorization** — `isAuthorized()` throws if `DISCORD_USER_ID` is not set. No fallback to "allow all".
3. **Input validation** — `validateStrategyId()` and `validateTextInput()` are called before any processing. Strategy IDs: `[a-zA-Z0-9_-]{1,50}`. Text inputs: max length enforced.
4. **Rate limiting** — Sliding window (5 requests/60s) for Claude spawns via `checkRateLimit()`.
5. **Research queue depth** — Max 1 concurrent research task to prevent resource exhaustion.
6. **No secrets in logs** — Error messages are truncated. Never log tokens, API keys, or full prompts.
7. **Shell injection prevention** — Remote prompts are written to temp files via stdin pipe, not interpolated into shell commands.

## Database

**Connection:** PostgreSQL on CT120 (192.168.68.120:5433), database `trading`, schema `strategist`

**Tables:**

| Table | Purpose |
|-------|---------|
| `strategist.strategies` | Strategy definitions with backtest/paper results |
| `strategist.positions` | Trade positions (open/closed) linked to strategies |
| `strategist.regime_log` | Historical BTC/ETH regime assessments |
| `strategist.conversations` | User/assistant message log |
| `strategist.memory` | Long-term facts, lessons, observations |
| `strategist.cron_log` | Cron job execution history |

Schema: `schema/001_create_strategist.sql`

## Deployment (CT100)

The bot runs as `claude-strategist.service` via systemd on CT100.

```bash
# Deploy steps (automated via /strategist-deploy skill):
# 1. Commit & push strategist submodule
# 2. Update parent repo submodule pointer, commit & push
# 3. SSH to CT100, pull changes
# 4. bun install && bun build
# 5. systemctl restart claude-strategist
# 6. Verify logs for "Bot is running!"
```

**Service user:** `strategist` (non-root)
**Working directory:** `/opt/ArkNode-AI/projects/trading-signal-ai/strategist`
**Bun path:** `/home/strategist/.bun/bin/bun`
**Claude path:** `/home/strategist/.local/bin/claude`

## Environment Variables

Required in `.env` (gitignored, never edit via Claude Code):
- `DISCORD_BOT_TOKEN` — Bot token from Discord Developer Portal
- `DISCORD_USER_ID` — Authorized user ID (fail-closed auth)
- `DISCORD_CHANNEL_ID` — Channel for plain text messages
- `DISCORD_WEBHOOK_URL` — Webhook for cron notifications
- `ANTHROPIC_API_KEY` — For Claude CLI
- `DATABASE_URL` — PostgreSQL connection string

## Conventions

- **Runtime:** Bun (not Node.js). Use `bun run`, `bun install`, `bun build`.
- **No build step for dev:** `bun run src/relay.ts` runs TypeScript directly.
- **Production build:** `bun build src/relay.ts --target=bun --outdir=dist` for bundled output.
- **State files** in `state/` are local JSON caches. The database is always the source of truth.
- **Discord message limit:** 2000 chars. Use `splitMessage()` / `sendChunkedReply()` for long responses.
- **Confidence values:** Always 0.0-1.0 decimal range (not percentages).
