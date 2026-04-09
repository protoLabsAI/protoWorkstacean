-- Migration: add ceremony_outcomes table to knowledge.db
-- Stores execution results for each ceremony run.

CREATE TABLE IF NOT EXISTS ceremony_outcomes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT    NOT NULL,
  ceremony_id  TEXT    NOT NULL,
  skill        TEXT    NOT NULL,
  status       TEXT    NOT NULL CHECK (status IN ('success', 'failure', 'timeout')),
  duration_ms  INTEGER NOT NULL,
  targets      TEXT    NOT NULL,   -- JSON array of project paths
  started_at   INTEGER NOT NULL,   -- Unix timestamp ms
  completed_at INTEGER NOT NULL,   -- Unix timestamp ms
  result       TEXT,               -- Optional result summary
  error        TEXT                -- Optional error message
);

CREATE INDEX IF NOT EXISTS idx_ceremony_outcomes_ceremony_id
  ON ceremony_outcomes(ceremony_id);

CREATE INDEX IF NOT EXISTS idx_ceremony_outcomes_started_at
  ON ceremony_outcomes(started_at);
