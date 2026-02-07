# Claude Master Strategist — Discord Bot

An AI-powered BTC/ETH trading strategist that connects Discord to Claude Code CLI. Send a slash command or plain message in Discord, the relay spawns `claude -p` with full trading-signal-ai context, and sends the response back.

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Discord    │────▶│    Relay     │────▶│  Claude CLI  │
│    (you)     │◀────│  (always on) │◀────│   (spawned)  │
└──────────────┘     └──────────────┘     └──────────────┘
```

## Requirements

- [Bun](https://bun.sh/) runtime
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Discord Bot Token (from the [Discord Developer Portal](https://discord.com/developers/applications))
- PostgreSQL with `strategist` schema on CT120 (see `schema/001_create_strategist.sql`)

## Quick Start

```bash
cd strategist

# Install dependencies
bun install

# Copy and edit environment variables
cp .env.example .env
# Edit .env with your Discord bot token, user ID, channel ID, webhook URL

# Apply database schema
psql -h 192.168.68.120 -p 5433 -U trading_app -d trading -f schema/001_create_strategist.sql

# Run
bun run src/relay.ts
```

## Slash Commands

| Command | Description | Claude Spawn? |
|---------|-------------|:---:|
| `/status` | Quick state summary (regime, strategies, P&L) | No |
| `/regime` | Force fresh BTC/ETH regime analysis | Yes |
| `/performance` | Force trade performance review | Yes |
| `/strategies` | List all strategies with status | Yes |
| `/activate <id>` | Activate a strategy for paper trading | Yes |
| `/research <desc>` | Research & backtest a strategy on CT110 (GPU) | Yes (remote) |
| `/ask <question>` | Ask Claude anything about BTC/ETH trading | Yes |
| `/help` | Show available commands | No |

Plain text messages in the configured channel are also forwarded to Claude with full context.

## Cron Jobs

Automated background tasks that run independently of the Discord bot:

| Job | Schedule | Script | Description |
|-----|----------|--------|-------------|
| Market Analysis | Every 2h | `src/cron/market-analysis.ts` | Regime assessment, state file + DB logging |
| Trade Review | Every 6h (offset :30) | `src/cron/trade-review.ts` | Performance metrics, lesson extraction |
| Strategy Watchdog | Every 1h (offset :15) | `src/cron/strategy-watchdog.ts` | Health checks, cron freshness monitoring |

Run manually:
```bash
bun run cron:market
bun run cron:review
bun run cron:watchdog
```

## Daemon Setup (systemd on CT100)

### Main Bot Service

```bash
sudo cp daemon/claude-strategist.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now claude-strategist
```

### Cron Timers

```bash
sudo cp daemon/claude-strategist-market.service daemon/claude-strategist-market.timer \
       daemon/claude-strategist-review.service daemon/claude-strategist-review.timer \
       daemon/claude-strategist-watchdog.service daemon/claude-strategist-watchdog.timer \
       /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable --now claude-strategist-market.timer
sudo systemctl enable --now claude-strategist-review.timer
sudo systemctl enable --now claude-strategist-watchdog.timer
```

Check timer status:
```bash
systemctl list-timers 'claude-strategist-*'
journalctl -u claude-strategist-market -f
```

## Architecture

```
strategist/
├── src/
│   ├── relay.ts                  # Discord bot + slash command handlers
│   ├── types.ts                  # TypeScript interfaces
│   ├── helpers/
│   │   ├── claude-runner.ts      # Claude CLI spawn (local + SSH remote)
│   │   ├── db.ts                 # PostgreSQL via psql CLI
│   │   ├── discord.ts            # Webhook helpers for cron notifications
│   │   ├── prompt-builder.ts     # Context-enriched prompt construction
│   │   └── state.ts              # JSON state file caching
│   └── cron/
│       ├── market-analysis.ts    # Regime assessment (every 2h)
│       ├── trade-review.ts       # Performance review (every 6h)
│       └── strategy-watchdog.ts  # Health monitoring (every 1h)
├── schema/
│   └── 001_create_strategist.sql # Database schema
├── daemon/
│   ├── claude-strategist.service # Main bot systemd service
│   ├── claude-strategist-market.service + .timer
│   ├── claude-strategist-review.service + .timer
│   └── claude-strategist-watchdog.service + .timer
├── state/                        # Cached JSON state files (gitignored)
├── .env.example                  # Environment variable template
└── package.json
```

## Environment Variables

```bash
# Required — Discord
DISCORD_BOT_TOKEN=           # Bot token from Developer Portal
DISCORD_USER_ID=             # Your Discord user ID (for auth)
DISCORD_CHANNEL_ID=          # Channel for plain text + cron notifications
DISCORD_WEBHOOK_URL=         # Webhook URL for cron job notifications

# Required — Anthropic
ANTHROPIC_API_KEY=           # For Claude CLI

# Required — Database
DATABASE_URL=postgresql://trading_app:trading_app_2026@192.168.68.120:5433/trading

# Optional — Paths
CLAUDE_PATH=claude           # Path to claude CLI if not in PATH
PROJECT_ROOT=                # Override auto-detected project root

# Optional — CT110 Research
CT110_HOST=192.168.68.110
CT110_PROJECT_ROOT=/opt/ArkNode-AI/projects/trading-signal-ai
```

## Security

- **User ID verification** — Only the configured `DISCORD_USER_ID` can interact with the bot
- **Private bot** — Unauthorized users receive an ephemeral "This bot is private" message
- **Lock file** — Prevents multiple bot instances from running simultaneously
- `.env` is gitignored — never commit tokens
