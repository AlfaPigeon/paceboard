import Database from 'better-sqlite3';
import { DB_PATH } from './config.js';

let db;

export function getDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS boards (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idea',
      notion_page_id TEXT,
      notion_last_edited TEXT,
      target_runtime_sec REAL DEFAULT 600,
      hours_cap REAL,
      hours_manual REAL DEFAULT 0,
      hours_aw_filter TEXT,
      hours_aw_start TEXT,
      audience_json TEXT NOT NULL DEFAULT '{}',
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      x REAL NOT NULL DEFAULT 0,
      y REAL NOT NULL DEFAULT 0,
      w REAL NOT NULL DEFAULT 240,
      h REAL NOT NULL DEFAULT 140,
      z INTEGER NOT NULL DEFAULT 0,
      group_id TEXT,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wires (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      from_card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      to_card_id TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'flow',
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      title TEXT NOT NULL DEFAULT 'Section',
      x REAL NOT NULL DEFAULT 0,
      y REAL NOT NULL DEFAULT 0,
      w REAL NOT NULL DEFAULT 480,
      h REAL NOT NULL DEFAULT 320,
      color TEXT NOT NULL DEFAULT '#334155',
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS timeline_beats (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      card_id TEXT REFERENCES cards(id) ON DELETE SET NULL,
      ord INTEGER NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      planned_sec REAL NOT NULL DEFAULT 30,
      clip_in_sec REAL,
      clip_out_sec REAL,
      serves_promise INTEGER NOT NULL DEFAULT 1,
      data_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_assets (
      id TEXT PRIMARY KEY,
      board_id TEXT,
      source_path TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      source_mtime REAL NOT NULL,
      duration_sec REAL,
      probe_json TEXT NOT NULL DEFAULT '{}',
      proxy_path TEXT,
      thumbs_json TEXT NOT NULL DEFAULT '[]',
      waveform_json TEXT NOT NULL DEFAULT '[]',
      scenes_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      progress REAL NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      progress REAL NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      cancel INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hour_entries (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      hours REAL NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_cards_board ON cards(board_id);
    CREATE INDEX IF NOT EXISTS idx_wires_board ON wires(board_id);
    CREATE INDEX IF NOT EXISTS idx_beats_board ON timeline_beats(board_id, ord);
    CREATE INDEX IF NOT EXISTS idx_media_hash ON media_assets(source_hash, source_mtime);
  `);
}

export function nowIso() {
  return new Date().toISOString();
}

export function rowToBoard(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    notionPageId: row.notion_page_id,
    notionLastEdited: row.notion_last_edited,
    targetRuntimeSec: row.target_runtime_sec,
    hoursCap: row.hours_cap,
    hoursManual: row.hours_manual,
    hoursAwFilter: row.hours_aw_filter,
    hoursAwStart: row.hours_aw_start,
    audience: safeJson(row.audience_json, {}),
    meta: safeJson(row.meta_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToCard(row) {
  if (!row) return null;
  return {
    id: row.id,
    boardId: row.board_id,
    type: row.type,
    title: row.title,
    body: row.body,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    z: row.z,
    groupId: row.group_id,
    data: safeJson(row.data_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToWire(row) {
  if (!row) return null;
  return {
    id: row.id,
    boardId: row.board_id,
    fromCardId: row.from_card_id,
    toCardId: row.to_card_id,
    kind: row.kind,
    data: safeJson(row.data_json, {}),
    createdAt: row.created_at,
  };
}

export function rowToGroup(row) {
  if (!row) return null;
  return {
    id: row.id,
    boardId: row.board_id,
    title: row.title,
    x: row.x,
    y: row.y,
    w: row.w,
    h: row.h,
    color: row.color,
    data: safeJson(row.data_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToBeat(row) {
  if (!row) return null;
  return {
    id: row.id,
    boardId: row.board_id,
    cardId: row.card_id,
    ord: row.ord,
    label: row.label,
    plannedSec: row.planned_sec,
    clipInSec: row.clip_in_sec,
    clipOutSec: row.clip_out_sec,
    servesPromise: !!row.serves_promise,
    data: safeJson(row.data_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function safeJson(text, fallback) {
  try {
    return JSON.parse(text ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}
