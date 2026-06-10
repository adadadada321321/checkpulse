CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  domain TEXT UNIQUE NOT NULL,
  alert_email TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'solo',
  active INTEGER NOT NULL DEFAULT 1,
  stripe_subscription_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS check_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id TEXT NOT NULL,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  passed INTEGER NOT NULL,
  failure_step INTEGER,
  diagnosis TEXT,
  steps_json TEXT,
  duration_ms INTEGER,
  FOREIGN KEY (store_id) REFERENCES stores(id)
);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  alert_sent INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (store_id) REFERENCES stores(id)
);
