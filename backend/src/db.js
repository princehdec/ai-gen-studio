import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { nowISO } from './util.js';

mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS generations (
    id                TEXT PRIMARY KEY,
    type              TEXT NOT NULL CHECK (type IN ('video','image','audio')),
    mode              TEXT,
    prompt            TEXT NOT NULL,
    model             TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    provider_job_id   TEXT,
    settings          TEXT,
    file_path         TEXT,
    mime_type         TEXT,
    file_size         INTEGER,
    cost              REAL,
    error             TEXT,
    created_at        TEXT NOT NULL,
    completed_at      TEXT,
    provider_checked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_gen_type_created ON generations(type, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_gen_status ON generations(status);
  CREATE TABLE IF NOT EXISTS ugc_projects (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    brief       TEXT NOT NULL,
    plan        TEXT,
    status      TEXT NOT NULL DEFAULT 'draft',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ugc_updated ON ugc_projects(updated_at DESC);
  CREATE TABLE IF NOT EXISTS ugc_assets (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL CHECK (type IN ('character','product')),
    name        TEXT NOT NULL,
    description TEXT,
    file_path   TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    file_size   INTEGER NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ugc_assets_type ON ugc_assets(type, updated_at DESC);
  CREATE TABLE IF NOT EXISTS lab_documents (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    file_size   INTEGER NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lab_chunks (
    id          TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_lab_chunks_doc ON lab_chunks(document_id, chunk_index);
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id          TEXT PRIMARY KEY,
    goal        TEXT NOT NULL,
    provider    TEXT,
    model       TEXT,
    status      TEXT NOT NULL DEFAULT 'draft',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workflow_steps (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL,
    step_index  INTEGER NOT NULL,
    name        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    output     TEXT,
    error       TEXT,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_steps_run ON workflow_steps(run_id, step_index);
  CREATE TABLE IF NOT EXISTS usage_events (
    id          TEXT PRIMARY KEY,
    provider    TEXT NOT NULL,
    model       TEXT,
    operation   TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    estimated_cost REAL,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS credit_ledger (
    id          TEXT PRIMARY KEY,
    amount      REAL NOT NULL,
    reason      TEXT NOT NULL,
    reference   TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS memories (
    id          TEXT PRIMARY KEY,
    content     TEXT NOT NULL,
    tags        TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
`);

const COLS = [
  'id', 'type', 'mode', 'prompt', 'model', 'status', 'provider_job_id', 'settings',
  'file_path', 'mime_type', 'file_size', 'cost', 'error', 'created_at', 'completed_at',
  'provider_checked_at',
];

const SELECT_ALL = `SELECT ${COLS.join(', ')} FROM generations`;
const SELECT_BY_ID = `SELECT ${COLS.join(', ')} FROM generations WHERE id = ?`;

export function insertGeneration(g) {
  db.prepare(`
    INSERT INTO generations
      (id, type, mode, prompt, model, status, settings, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    g.id,
    g.type,
    g.mode ?? null,
    g.prompt,
    g.model,
    g.status ?? 'pending',
    g.settings ? JSON.stringify(g.settings) : null,
    g.created_at ?? nowISO(),
  );
  return getGeneration(g.id);
}

export function getGeneration(id) {
  return db.prepare(SELECT_BY_ID).get(id) ?? null;
}

export function updateGeneration(id, fields) {
  const sets = [];
  const vals = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!COLS.includes(key) || key === 'id') continue;
    sets.push(`${key} = ?`);
    vals.push(value === undefined ? null : value);
  }
  if (!sets.length) return;
  db.prepare(`UPDATE generations SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return getGeneration(id);
}

export function listGenerations({ type, status, q, limit = 50, offset = 0 }) {
  const { where, params } = buildFilters({ type, status, q });
  const rows = db.prepare(
    `${SELECT_ALL} ${where} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
  ).all(...params, Math.min(limit, 100), Math.max(offset, 0));
  const { total } = db.prepare(`SELECT COUNT(*) AS total FROM generations ${where}`).get(...params);
  return { items: rows, total };
}

function buildFilters({ type, status, q }) {
  const clauses = [];
  const params = [];
  if (type) {
    clauses.push('type = ?');
    params.push(type);
  }
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (q) {
    clauses.push(`prompt LIKE ? ESCAPE '\\'`);
    params.push(`%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export function deleteGeneration(id) {
  db.prepare('DELETE FROM generations WHERE id = ?').run(id);
}
