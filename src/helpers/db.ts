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
