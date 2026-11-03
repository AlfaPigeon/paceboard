import { getDb, nowIso } from '../db.js';
import { id } from '../util.js';

const handlers = new Map();
const running = new Map(); // jobId -> AbortController

export function registerJobHandler(kind, fn) {
  handlers.set(kind, fn);
}

export function enqueueJob(kind, payload = {}) {
  const db = getDb();
  const jobId = id('job');
  const ts = nowIso();
  db.prepare(`
    INSERT INTO jobs (id, kind, status, progress, payload_json, result_json, error, cancel, created_at, updated_at)
    VALUES (?, ?, 'queued', 0, ?, '{}', NULL, 0, ?, ?)
  `).run(jobId, kind, JSON.stringify(payload), ts, ts);
  setImmediate(() => pump());
  return getJob(jobId);
}

export function getJob(jobId) {
  const row = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    payload: JSON.parse(row.payload_json || '{}'),
    result: JSON.parse(row.result_json || '{}'),
    error: row.error,
    cancel: !!row.cancel,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function cancelJob(jobId) {
  const db = getDb();
  db.prepare(`UPDATE jobs SET cancel = 1, updated_at = ? WHERE id = ?`).run(nowIso(), jobId);
  const ctl = running.get(jobId);
  if (ctl) ctl.abort();
  return getJob(jobId);
}

export function updateJob(jobId, patch) {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!cur) return null;
  const status = patch.status ?? cur.status;
  const progress = patch.progress ?? cur.progress;
  const result = patch.result != null ? JSON.stringify(patch.result) : cur.result_json;
  const error = patch.error !== undefined ? patch.error : cur.error;
  db.prepare(`UPDATE jobs SET status=?, progress=?, result_json=?, error=?, updated_at=? WHERE id=?`)
    .run(status, progress, result, error, nowIso(), jobId);
  return getJob(jobId);
}

let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (true) {
      const row = getDb().prepare(`SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`).get();
      if (!row) break;
      const handler = handlers.get(row.kind);
      const ctl = new AbortController();
      running.set(row.id, ctl);
      updateJob(row.id, { status: 'running', progress: 0 });
      try {
        if (!handler) throw new Error(`No handler for job kind ${row.kind}`);
        const payload = JSON.parse(row.payload_json || '{}');
        const result = await handler(payload, {
          jobId: row.id,
          signal: ctl.signal,
          setProgress: (p) => updateJob(row.id, { progress: p }),
          isCancelled: () => !!getDb().prepare('SELECT cancel FROM jobs WHERE id = ?').get(row.id)?.cancel,
        });
        if (getDb().prepare('SELECT cancel FROM jobs WHERE id = ?').get(row.id)?.cancel) {
          updateJob(row.id, { status: 'cancelled', progress: 0, result: result || {} });
        } else {
          updateJob(row.id, { status: 'done', progress: 1, result: result || {} });
        }
      } catch (err) {
        const cancelled = ctl.signal.aborted || getDb().prepare('SELECT cancel FROM jobs WHERE id = ?').get(row.id)?.cancel;
        updateJob(row.id, {
          status: cancelled ? 'cancelled' : 'error',
          error: cancelled ? 'cancelled' : (err.message || String(err)),
        });
      } finally {
        running.delete(row.id);
      }
    }
  } finally {
    pumping = false;
  }
}
