/**
 * Database helpers for strategist schema.
 * Uses psql CLI since we're in Bun (no native pg driver needed).
 */

import { spawn } from "bun";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://trading_app:trading_app_2026@192.168.68.120:5433/trading";

/**
 * Run a SQL query via psql. Returns stdout on success, throws on failure.
 */
async function query(sql: string): Promise<string> {
  const proc = spawn(
    ["psql", DATABASE_URL, "-t", "-A", "-c", sql],
    { stdout: "pipe", stderr: "pipe" }
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.error(`[db] Query failed: ${stderr.trim()}`);
    throw new Error(`psql error: ${stderr.trim()}`);
  }

  return stdout.trim();
}

/**
 * Log a conversation message (user or assistant) to strategist.conversations.
 */
export async function logConversation(params: {
  role: "user" | "assistant";
  content: string;
  command?: string | null;
  duration_ms?: number | null;
}): Promise<void> {
  try {
    // Escape single quotes for SQL
    const content = params.content.replace(/'/g, "''").substring(0, 10000);
    const command = params.command ? `'${params.command}'` : "NULL";
    const duration = params.duration_ms ?? "NULL";

    await query(
      `INSERT INTO strategist.conversations (role, content, command, duration_ms) ` +
        `VALUES ('${params.role}', '${content}', ${command}, ${duration})`
    );
  } catch (err) {
    console.error("[db] Failed to log conversation:", err);
  }
}

/**
 * Fetch recent conversation messages for context injection.
 * Returns newest-first, caller should reverse for chronological order.
 */
export async function getRecentConversations(
  limit: number = 10
): Promise<Array<{ role: string; content: string; created_at: string }>> {
  try {
    const result = await query(
      `SELECT role, content, created_at FROM strategist.conversations ` +
        `ORDER BY created_at DESC LIMIT ${limit}`
    );

    if (!result) return [];

    return result.split("\n").map((row) => {
      const [role, ...rest] = row.split("|");
      const created_at = rest.pop() || "";
      const content = rest.join("|"); // content might contain |
      return { role, content, created_at };
    });
  } catch {
    return [];
  }
}

/**
 * Save a memory entry to strategist.memory table.
 */
export async function saveMemory(params: {
  type: "fact" | "observation" | "lesson" | "preference";
  content: string;
  context?: string;
  confidence?: number;
  source?: string;
}): Promise<void> {
  try {
    const content = params.content.replace(/'/g, "''").substring(0, 5000);
    const context = params.context
      ? `'${params.context.replace(/'/g, "''").substring(0, 1000)}'`
      : "NULL";
    const confidence = params.confidence ?? 1.0;
    const source = params.source
      ? `'${params.source.replace(/'/g, "''")}'`
      : "NULL";

    await query(
      `INSERT INTO strategist.memory (type, content, context, confidence, source) ` +
        `VALUES ('${params.type}', '${content}', ${context}, ${confidence}, ${source})`
    );
  } catch (err) {
    console.error("[db] Failed to save memory:", err);
  }
}

/**
 * Fetch memories from strategist.memory table.
 * Returns highest-confidence entries, optionally filtered by type.
 */
export async function getMemories(
  type?: string,
  limit: number = 10
): Promise<Array<{ type: string; content: string; confidence: number }>> {
  try {
    const typeFilter = type ? `WHERE type = '${type}'` : "";
    const result = await query(
      `SELECT type, content, confidence FROM strategist.memory ` +
        `${typeFilter} ORDER BY confidence DESC, created_at DESC LIMIT ${limit}`
    );

    if (!result) return [];

    return result.split("\n").map((row) => {
      const [memType, ...rest] = row.split("|");
      const confidence = parseFloat(rest.pop() || "1.0");
      const content = rest.join("|");
      return { type: memType, content, confidence };
    });
  } catch {
    return [];
  }
}

/**
 * Fetch a strategy by strategy_id for validation.
 */
export async function getStrategy(
  strategyId: string
): Promise<{
  strategy_id: string;
  status: string;
  backtest_results: string | null;
} | null> {
  try {
    const escaped = strategyId.replace(/'/g, "''");
    const result = await query(
      `SELECT strategy_id, status, backtest_results::text ` +
        `FROM strategist.strategies WHERE strategy_id = '${escaped}'`
    );

    if (!result) return null;

    const [strategy_id, status, ...rest] = result.split("|");
    const backtest_results = rest.join("|") || null;
    return { strategy_id, status, backtest_results };
  } catch {
    return null;
  }
}

/**
 * Log a cron job execution to strategist.cron_log table.
 */
export async function logCronRun(params: {
  job_name: string;
  status: "success" | "failure";
  duration_ms?: number;
  error_message?: string;
}): Promise<void> {
  try {
    const duration = params.duration_ms ?? "NULL";
    const errorMsg = params.error_message
      ? `'${params.error_message.replace(/'/g, "''").substring(0, 2000)}'`
      : "NULL";

    await query(
      `INSERT INTO strategist.cron_log (job_name, status, duration_ms, error_message) ` +
        `VALUES ('${params.job_name}', '${params.status}', ${duration}, ${errorMsg})`
    );
  } catch (err) {
    console.error("[db] Failed to log cron run:", err);
  }
}

/**
 * Get the last successful run time for a cron job.
 * Returns ISO timestamp string or null if never succeeded.
 */
export async function getLastCronSuccess(
  jobName: string
): Promise<string | null> {
  try {
    const result = await query(
      `SELECT created_at FROM strategist.cron_log ` +
        `WHERE job_name = '${jobName}' AND status = 'success' ` +
        `ORDER BY created_at DESC LIMIT 1`
    );
    return result || null;
  } catch {
    return null;
  }
}
