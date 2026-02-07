/**
 * TypeScript interfaces for state file schemas and database records.
 */

// ============================================================
// STATE FILE SCHEMAS (cached JSON, DB is source of truth)
// ============================================================

export interface MarketRegimeState {
  regime: "RALLY" | "SELLOFF" | "NEUTRAL";
  btc_price: number;
  btc_24h_change: number;
  eth_price: number;
  eth_24h_change: number;
  trading_bias: string | null;
  confidence: number;
  reasoning: string;
  assessed_at: string; // ISO 8601
}

export interface ActiveStrategy {
  strategy_id: string;
  name: string;
  asset: "BTC" | "ETH";
  direction: "LONG" | "SHORT" | "BOTH";
  status: "draft" | "paper" | "live" | "retired";
  regime_condition: string | null;
  description: string;
}

export interface ActiveStrategiesState {
  strategies: ActiveStrategy[];
  updated_at: string;
}

export interface TradeRecord {
  strategy_id: string;
  asset: string;
  direction: string;
  entry_price: number;
  entry_time: string;
  exit_price: number | null;
  exit_time: string | null;
  pnl_pct: number | null;
  status: "open" | "closed";
}

export interface PerformanceLogState {
  total_trades: number;
  open_positions: number;
  win_rate: number | null;
  total_pnl_pct: number | null;
  recent_trades: TradeRecord[];
  summary: string;
  reviewed_at: string;
}

export interface ResearchRequest {
  id: string;
  description: string;
  status: "queued" | "running" | "completed" | "failed";
  branch: string | null;
  pr_url: string | null;
  result_summary: string | null;
  requested_at: string;
  completed_at: string | null;
}

export interface ResearchQueueState {
  queue: ResearchRequest[];
  updated_at: string;
}

// ============================================================
// DATABASE RECORD TYPES (strategist schema)
// ============================================================

export interface DbStrategy {
  id: number;
  strategy_id: string;
  name: string;
  asset: string;
  direction: string;
  description: string;
  entry_rules: Record<string, unknown>;
  exit_rules: Record<string, unknown>;
  regime_condition: string | null;
  parameters: Record<string, unknown> | null;
  status: string;
  backtest_results: Record<string, unknown> | null;
  paper_results: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface DbPosition {
  id: number;
  strategy_id: string;
  asset: string;
  direction: string;
  entry_price: number;
  entry_time: string;
  exit_price: number | null;
  exit_time: string | null;
  pnl_pct: number | null;
  pnl_usd: number | null;
  position_size_usd: number;
  leverage: number;
  status: string;
  exit_reason: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface DbRegimeLog {
  id: number;
  assessed_at: string;
  btc_price: number | null;
  btc_24h_change: number | null;
  eth_price: number | null;
  eth_24h_change: number | null;
  regime: string;
  trading_bias: string | null;
  confidence: number | null;
  reasoning: string | null;
  created_at: string;
}

export interface DbConversation {
  id: number;
  role: "user" | "assistant";
  content: string;
  command: string | null;
  claude_session_id: string | null;
  tokens_used: number | null;
  duration_ms: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface DbCronLog {
  id: number;
  job_name: string;
  status: "success" | "failure";
  duration_ms: number | null;
  error_message: string | null;
  created_at: string;
}

export interface DbMemory {
  id: number;
  type: "fact" | "observation" | "lesson" | "preference";
  content: string;
  context: string | null;
  confidence: number;
  source: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ============================================================
// CLAUDE RUNNER TYPES
// ============================================================

export interface ClaudeRunResult {
  output: string;
  exitCode: number;
  duration_ms: number;
  error: string | null;
}

export type ClaudeRunMode = "local" | "remote";
