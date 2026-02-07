/**
 * Database helpers for strategist schema.
 * Uses pg driver with parameterized queries to prevent SQL injection.
 */

import { Pool } from "pg";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://trading_app:trading_app_2026@192.168.68.120:5433/trading";

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

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
    await pool.query(
      `INSERT INTO strategist.conversations (role, content, command, duration_ms)
       VALUES ($1, $2, $3, $4)`,
      [
        params.role,
        params.content.substring(0, 10000),
        params.command ?? null,
        params.duration_ms ?? null,
      ]
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
    const result = await pool.query(
      `SELECT role, content, created_at FROM strategist.conversations
       ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return result.rows.map((row) => ({
      role: row.role,
      content: row.content,
      created_at: row.created_at.toISOString?.() ?? String(row.created_at),
    }));
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
    await pool.query(
      `INSERT INTO strategist.memory (type, content, context, confidence, source)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        params.type,
        params.content.substring(0, 5000),
        params.context?.substring(0, 1000) ?? null,
        params.confidence ?? 1.0,
        params.source ?? null,
      ]
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
    let result;
    if (type) {
      result = await pool.query(
        `SELECT type, content, confidence FROM strategist.memory
         WHERE type = $1 ORDER BY confidence DESC, created_at DESC LIMIT $2`,
        [type, limit]
      );
    } else {
      result = await pool.query(
        `SELECT type, content, confidence FROM strategist.memory
         ORDER BY confidence DESC, created_at DESC LIMIT $1`,
        [limit]
      );
    }
    return result.rows.map((row) => ({
      type: row.type,
      content: row.content,
      confidence: parseFloat(row.confidence),
    }));
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
    const result = await pool.query(
      `SELECT strategy_id, status, backtest_results::text
       FROM strategist.strategies WHERE strategy_id = $1`,
      [strategyId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return {
      strategy_id: row.strategy_id,
      status: row.status,
      backtest_results: row.backtest_results ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Activate a strategy by setting its status to 'paper'.
 * Returns true if a row was updated, false if strategy_id not found.
 */
export async function activateStrategy(strategyId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE strategist.strategies SET status = 'paper', updated_at = NOW() WHERE strategy_id = $1`,
    [strategyId]
  );
  return (result.rowCount ?? 0) > 0;
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
    await pool.query(
      `INSERT INTO strategist.cron_log (job_name, status, duration_ms, error_message)
       VALUES ($1, $2, $3, $4)`,
      [
        params.job_name,
        params.status,
        params.duration_ms ?? null,
        params.error_message?.substring(0, 2000) ?? null,
      ]
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
    const result = await pool.query(
      `SELECT created_at FROM strategist.cron_log
       WHERE job_name = $1 AND status = 'success'
       ORDER BY created_at DESC LIMIT 1`,
      [jobName]
    );
    if (result.rows.length === 0) return null;
    const created_at = result.rows[0].created_at;
    return created_at.toISOString?.() ?? String(created_at);
  } catch {
    return null;
  }
}

/**
 * Gracefully close the connection pool. Call on process exit.
 */
export async function closePool(): Promise<void> {
  await pool.end();
}
