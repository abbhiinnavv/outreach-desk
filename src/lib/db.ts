import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { emailKind, KIND_PRIORITY } from "./score";

export type DB = Database.Database;

/*
  The whole database is one file (data/outreach.db). It is free, needs no server,
  and you can open it with any SQLite viewer. Tables for later steps are created now
  so the plan is visible, but only campaigns, companies and contacts are used in Step 1.

  Status flow of a company:  imported -> enriched -> drafted -> approved -> sent -> replied
*/
const SCHEMA = `
CREATE TABLE IF NOT EXISTS campaigns (
  id               INTEGER PRIMARY KEY,
  name             TEXT NOT NULL,
  product          TEXT NOT NULL,
  pitch            TEXT NOT NULL,
  regions          TEXT NOT NULL,            -- JSON array, e.g. ["India","Singapore"]
  min_advisors     INTEGER NOT NULL DEFAULT 8,
  prefer_structured INTEGER NOT NULL DEFAULT 1,
  contact_pref     TEXT NOT NULL DEFAULT 'decision',   -- 'decision' | 'any'
  goal             TEXT NOT NULL DEFAULT 'demo',       -- 'demo' | 'reply' | 'pilot'
  tone             TEXT NOT NULL DEFAULT 'warm',       -- 'warm' | 'formal' | 'casual'
  sender           TEXT NOT NULL,
  daily_cap        INTEGER NOT NULL DEFAULT 10,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS companies (
  id           INTEGER PRIMARY KEY,
  campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  domain       TEXT NOT NULL,                -- normalised, e.g. "acme.com"
  city         TEXT,
  region       TEXT,
  advisors     INTEGER,
  structured   INTEGER NOT NULL DEFAULT 0,
  trigger      TEXT,                          -- reason to reach out now
  fit_score    INTEGER NOT NULL DEFAULT 0,
  fit_label    TEXT NOT NULL DEFAULT 'Low',
  fit_reasons  TEXT NOT NULL DEFAULT '[]',    -- JSON: which scoring rules passed
  status       TEXT NOT NULL DEFAULT 'imported',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (campaign_id, domain)                -- the same company is never added twice
);
CREATE INDEX IF NOT EXISTS idx_companies_campaign_fit ON companies (campaign_id, fit_score DESC);

CREATE TABLE IF NOT EXISTS contacts (
  id            INTEGER PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          TEXT,
  role          TEXT,
  email         TEXT NOT NULL,
  tier          TEXT NOT NULL DEFAULT 'general',      -- 'decision' | 'general'
  source_url    TEXT,                                  -- the page the email was found on
  method        TEXT NOT NULL DEFAULT 'imported',      -- 'imported' | 'crawled' | 'finder'
  verification  TEXT NOT NULL DEFAULT 'unchecked',     -- 'unchecked' | 'valid' | 'risky' | 'invalid'
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (company_id, email)
);

-- Step 3
CREATE TABLE IF NOT EXISTS drafts (
  id          INTEGER PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id  INTEGER REFERENCES contacts(id),
  subject_a   TEXT NOT NULL,
  subject_b   TEXT NOT NULL,
  variant     TEXT NOT NULL DEFAULT 'A',
  body        TEXT NOT NULL,
  rationale   TEXT,                           -- why this firm and why this angle (kept for every email)
  written_by  TEXT NOT NULL,                  -- 'gemini' | 'groq' | 'ollama' | 'template'
  status      TEXT NOT NULL DEFAULT 'pending',-- pending | approved | rejected | sent
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Step 5
CREATE TABLE IF NOT EXISTS sends (
  id            INTEGER PRIMARY KEY,
  draft_id      INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  scheduled_for TEXT,
  sent_at       TEXT,
  day_no        INTEGER,
  message_id    TEXT,
  thread_id     TEXT,
  status        TEXT NOT NULL DEFAULT 'scheduled'     -- scheduled | sent | failed | bounced
);

-- Step 6
CREATE TABLE IF NOT EXISTS replies (
  id             INTEGER PRIMARY KEY,
  send_id        INTEGER NOT NULL REFERENCES sends(id) ON DELETE CASCADE,
  body           TEXT NOT NULL,
  label          TEXT,                                 -- Interested | Not now | Unsubscribe | Out of office | Bounced
  labelled_by    TEXT,                                 -- 'rules' | 'gemini' | ...
  meeting_booked INTEGER NOT NULL DEFAULT 0,
  received_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Never email these again (unsubscribes, bounces).
CREATE TABLE IF NOT EXISTS suppression (
  email      TEXT PRIMARY KEY,
  reason     TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A simple audit trail: what the agent did, and when.
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,
  ref        TEXT,
  data       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

/*
  Small upgrades for databases created by an earlier step.
  Adds a column only if it is missing, so it is safe to run every time the app starts.
*/
function addColumn(db: DB, table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

function migrate(db: DB) {
  // Step 2: email finding
  addColumn(db, "companies", "crawl_status", "TEXT NOT NULL DEFAULT 'pending'"); // pending | crawling | done | failed
  addColumn(db, "companies", "crawl_note", "TEXT");
  addColumn(db, "companies", "crawled_at", "TEXT");
  addColumn(db, "contacts", "verify_note", "TEXT");
  // Step 2 fix: rank contacts so the best address is chosen first
  addColumn(db, "contacts", "kind", "TEXT");
  addColumn(db, "contacts", "priority", "INTEGER NOT NULL DEFAULT 0");
  // Step 4: sending
  addColumn(db, "sends", "to_email", "TEXT");
  addColumn(db, "sends", "error", "TEXT");
  // Step 5: replies
  addColumn(db, "replies", "message_id", "TEXT");
  addColumn(db, "replies", "from_email", "TEXT");
  addColumn(db, "replies", "subject", "TEXT");
  addColumn(db, "replies", "simulated", "INTEGER NOT NULL DEFAULT 0"); // 1 = a sample reply made for demos
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_replies_message ON replies(message_id)");
  // Re-label every contact whenever the labelling rules change (bump KIND_RULES_VERSION), so old rows follow the new rules.
  const KIND_RULES_VERSION = 2;
  const have = db.pragma("user_version", { simple: true }) as number;
  if (have < KIND_RULES_VERSION) {
    const all = db.prepare(`SELECT id, email FROM contacts`).all() as Array<{ id: number; email: string }>;
    const upd = db.prepare(`UPDATE contacts SET kind = ?, priority = ? WHERE id = ?`);
    db.transaction(() => { for (const c of all) { const k = emailKind(c.email); upd.run(k, KIND_PRIORITY[k], c.id); } })();
    db.pragma(`user_version = ${KIND_RULES_VERSION}`);
  }
}

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// One shared connection. The global keeps it alive across hot reloads in development.
const g = globalThis as unknown as { __outreachDb?: DB };

export function getDb(): DB {
  if (!g.__outreachDb) {
    g.__outreachDb = openDb(process.env.DB_PATH ?? path.join(process.cwd(), "data", "outreach.db"));
  }
  return g.__outreachDb;
}
