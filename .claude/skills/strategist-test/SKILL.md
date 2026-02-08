---
name: strategist-test
description: Smoke test the strategist bot (build, DB, service health)
user-invocable: true
disable-model-invocation: true
---

# Strategist Smoke Test

Verify the strategist bot builds, can connect to the database, and the service is healthy on CT100.

## Steps

### 1. TypeScript Compilation Check

Verify the code compiles without errors:
```bash
cd /Users/sunginkim/GIT4/ArkNode-AI/projects/trading-signal-ai/strategist && npx bun build src/relay.ts --target=bun --outdir=dist 2>&1
```
Expected: successful build output with no errors.

### 2. Database Connectivity Check

Verify the strategist schema is accessible:
```bash
ssh root@192.168.68.10 "pct exec 100 -- bash -c 'psql postgresql://trading_app:trading_app_2026@192.168.68.120:5433/trading -c \"SELECT count(*) FROM strategist.conversations\" -t -A'"
```
Expected: a number (the count of conversation records).

### 3. Schema Integrity Check

Verify all required tables exist:
```bash
ssh root@192.168.68.10 "pct exec 100 -- bash -c 'psql postgresql://trading_app:trading_app_2026@192.168.68.120:5433/trading -c \"SELECT table_name FROM information_schema.tables WHERE table_schema = '\\''strategist'\\'' ORDER BY table_name\" -t -A'"
```
Expected: `conversations`, `cron_log`, `memory`, `positions`, `regime_log`, `strategies`

### 4. Service Status on CT100

Check if the systemd service is running:
```bash
ssh root@192.168.68.10 "pct exec 100 -- systemctl status claude-strategist.service --no-pager"
```
Expected: `Active: active (running)`

### 5. Recent Logs Check

Check for errors in recent logs:
```bash
ssh root@192.168.68.10 "pct exec 100 -- journalctl -u claude-strategist.service --since '10 min ago' --no-pager | tail -20"
```
Expected: no error lines. Look for "Bot is running!" and normal command processing.

### 6. Cron Timer Status

Verify cron timers are active:
```bash
ssh root@192.168.68.10 "pct exec 100 -- systemctl list-timers 'claude-strategist-*' --no-pager"
```

## Report

Summarize results as:
- Build: PASS/FAIL
- Database: PASS/FAIL
- Schema: PASS/FAIL (list any missing tables)
- Service: PASS/FAIL
- Logs: PASS/FAIL (note any errors)
- Cron timers: PASS/FAIL
