-- Migration: Create strategist schema for Claude Master Strategist bot
-- Date: 2026-02-07
-- Database: trading @ CT120:5433
-- Run: psql -h 192.168.68.120 -p 5433 -U trading_app -d trading -f schema/001_create_strategist.sql

BEGIN;

CREATE SCHEMA IF NOT EXISTS strategist;

CREATE TABLE IF NOT EXISTS strategist.strategies (
    id SERIAL PRIMARY KEY,
    strategy_id TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    asset TEXT NOT NULL,               -- 'BTC' or 'ETH'
    direction TEXT NOT NULL,           -- 'LONG', 'SHORT', 'BOTH'
    description TEXT NOT NULL,
    entry_rules JSONB NOT NULL,
    exit_rules JSONB NOT NULL,
    regime_condition TEXT,             -- 'RALLY', 'SELLOFF', 'NEUTRAL', NULL
    parameters JSONB,
    status TEXT NOT NULL DEFAULT 'draft',  -- draft, paper, live, retired
    backtest_results JSONB,
    paper_results JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS strategist.positions (
    id SERIAL PRIMARY KEY,
    strategy_id TEXT NOT NULL REFERENCES strategist.strategies(strategy_id),
    asset TEXT NOT NULL,
    direction TEXT NOT NULL,
    entry_price REAL NOT NULL,
    entry_time TIMESTAMPTZ NOT NULL,
    exit_price REAL,
    exit_time TIMESTAMPTZ,
    pnl_pct REAL,
    pnl_usd REAL,
    position_size_usd REAL NOT NULL,
    leverage INT DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'open',
    exit_reason TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS strategist.regime_log (
    id SERIAL PRIMARY KEY,
    assessed_at TIMESTAMPTZ NOT NULL,
    btc_price REAL,
    btc_24h_change REAL,
    eth_price REAL,
    eth_24h_change REAL,
    regime TEXT NOT NULL,
    trading_bias TEXT,
    confidence REAL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    reasoning TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS strategist.conversations (
    id SERIAL PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    command TEXT,
    claude_session_id TEXT,
    tokens_used INT,
    duration_ms INT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS strategist.memory (
    id SERIAL PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('fact', 'observation', 'lesson', 'preference')),
    content TEXT NOT NULL,
    context TEXT,
    confidence REAL DEFAULT 1.0 CHECK (confidence >= 0.0 AND confidence <= 1.0),
    source TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS strategist.cron_log (
    id SERIAL PRIMARY KEY,
    job_name TEXT NOT NULL,
    status TEXT NOT NULL,
    duration_ms INT,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_strategist_cron_log_job ON strategist.cron_log(job_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_strategist_positions_strategy ON strategist.positions(strategy_id);
CREATE INDEX IF NOT EXISTS idx_strategist_positions_status ON strategist.positions(status);
CREATE INDEX IF NOT EXISTS idx_strategist_regime_log_time ON strategist.regime_log(assessed_at);
CREATE INDEX IF NOT EXISTS idx_strategist_memory_type ON strategist.memory(type);
CREATE INDEX IF NOT EXISTS idx_strategist_memory_updated ON strategist.memory(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_strategist_conversations_created ON strategist.conversations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_strategist_conversations_role ON strategist.conversations(role);
CREATE INDEX IF NOT EXISTS idx_strategist_conversations_command ON strategist.conversations(command);
CREATE INDEX IF NOT EXISTS idx_strategist_strategies_status ON strategist.strategies(status);

-- Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION strategist.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_strategies_updated_at ON strategist.strategies;
CREATE TRIGGER trg_strategies_updated_at
  BEFORE UPDATE ON strategist.strategies
  FOR EACH ROW EXECUTE FUNCTION strategist.update_updated_at();

DROP TRIGGER IF EXISTS trg_memory_updated_at ON strategist.memory;
CREATE TRIGGER trg_memory_updated_at
  BEFORE UPDATE ON strategist.memory
  FOR EACH ROW EXECUTE FUNCTION strategist.update_updated_at();

-- Permissions
GRANT ALL ON SCHEMA strategist TO trading_app;
GRANT ALL ON ALL TABLES IN SCHEMA strategist TO trading_app;
GRANT ALL ON ALL SEQUENCES IN SCHEMA strategist TO trading_app;

COMMIT;
