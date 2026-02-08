---
name: strategist-deploy
description: Deploy the strategist Discord bot to CT100 production
user-invocable: true
disable-model-invocation: true
---

# Deploy Strategist to CT100

Deploy the Claude Master Strategist Discord bot to production on CT100.

## Steps

1. **Check for uncommitted changes in strategist submodule:**
   ```bash
   cd projects/trading-signal-ai/strategist && git status
   ```
   If there are uncommitted changes, commit them with a descriptive message.

2. **Push strategist submodule:**
   ```bash
   cd projects/trading-signal-ai/strategist && git push origin HEAD
   ```

3. **Update parent repo submodule pointer:**
   ```bash
   cd /Users/sunginkim/GIT4/ArkNode-AI
   git add projects/trading-signal-ai/strategist
   git commit -m "chore: update strategist submodule"
   git push origin HEAD
   ```

4. **Pull changes on CT100:**
   ```bash
   ssh root@192.168.68.10 "pct exec 100 -- bash -c 'cd /opt/ArkNode-AI && git pull origin master && git submodule update --remote projects/trading-signal-ai/strategist'"
   ```

5. **Install dependencies and build on CT100:**
   ```bash
   ssh root@192.168.68.10 "pct exec 100 -- bash -c 'cd /opt/ArkNode-AI/projects/trading-signal-ai/strategist && /home/strategist/.bun/bin/bun install && /home/strategist/.bun/bin/bun build src/relay.ts --target=bun --outdir=dist'"
   ```

6. **Restart service:**
   ```bash
   ssh root@192.168.68.10 "pct exec 100 -- systemctl restart claude-strategist.service"
   ```

7. **Verify deployment:**
   ```bash
   ssh root@192.168.68.10 "pct exec 100 -- bash -c 'sleep 5 && journalctl -u claude-strategist.service --since \"30 seconds ago\" --no-pager'"
   ```
   Look for "Bot is running!" in the output.

## Rollback

If deployment fails:
```bash
ssh root@192.168.68.10 "pct exec 100 -- bash -c 'cd /opt/ArkNode-AI/projects/trading-signal-ai/strategist && git checkout HEAD~1'"
ssh root@192.168.68.10 "pct exec 100 -- systemctl restart claude-strategist.service"
```
