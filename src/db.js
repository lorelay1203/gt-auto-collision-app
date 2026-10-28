'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, process.env.DB_FILE || 'gt.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY,
  case_number TEXT NOT NULL UNIQUE,
  access_token_hash TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'recibido',
  name TEXT NOT NULL, phone TEXT NOT NULL, email TEXT NOT NULL,
  make TEXT NOT NULL, model TEXT NOT NULL, year INTEGER NOT NULL, vin TEXT,
  payer TEXT NOT NULL, insurer TEXT, claim_number TEXT,
  accident_desc TEXT NOT NULL, drivable TEXT NOT NULL,
  consent_at TEXT NOT NULL, consent_version TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, stored_name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  info_request_id INTEGER, uploaded_by TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS info_requests (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  message TEXT NOT NULL, wants_photos INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'abierta', response_text TEXT,
  created_at TEXT NOT NULL, responded_at TEXT
);
CREATE TABLE IF NOT EXISTS estimates (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  version INTEGER NOT NULL, pdf_stored_name TEXT NOT NULL,
  total_cents INTEGER NOT NULL, deposit_cents INTEGER NOT NULL, notes TEXT,
  source TEXT NOT NULL DEFAULT 'manual_pdf',
  published_at TEXT NOT NULL, superseded_at TEXT,
  UNIQUE(case_id, version)
);
CREATE TABLE IF NOT EXISTS acceptances (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  estimate_id INTEGER NOT NULL UNIQUE REFERENCES estimates(id),
  estimate_version INTEGER NOT NULL,
  signer_name TEXT NOT NULL, accepted_at TEXT NOT NULL,
  ip TEXT, user_agent TEXT, recorded_by TEXT NOT NULL, terms_version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  estimate_id INTEGER REFERENCES estimates(id),
  amount_cents INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'deposito',
  provider TEXT NOT NULL, mode TEXT NOT NULL, provider_ref TEXT, checkout_url TEXT,
  status TEXT NOT NULL DEFAULT 'pendiente', method_note TEXT,
  created_at TEXT NOT NULL, paid_at TEXT
);
-- Evita cobros duplicados: un solo depósito pagado en línea por versión del estimado.
CREATE UNIQUE INDEX IF NOT EXISTS one_online_paid_per_estimate
  ON payments(estimate_id) WHERE status = 'pagado' AND provider IN ('stripe','demo');
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_ref ON payments(provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  requested_date TEXT NOT NULL, requested_slot TEXT NOT NULL, client_note TEXT,
  status TEXT NOT NULL DEFAULT 'solicitada', confirmed_for TEXT, admin_note TEXT,
  created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,
  actor TEXT NOT NULL, type TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY, kind TEXT NOT NULL, admin_id INTEGER, case_id INTEGER,
  csrf TEXT NOT NULL, flash TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, received_at TEXT NOT NULL);
`);

const now = () => new Date().toISOString();

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function logEvent(caseId, actor, type, detail = '') {
  db.prepare('INSERT INTO events(case_id, actor, type, detail, created_at) VALUES(?,?,?,?,?)').run(caseId, actor, type, detail, now());
}

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

module.exports = { db, now, getSetting, setSetting, logEvent, tx };
