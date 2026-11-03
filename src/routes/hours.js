import { Router } from 'express';
import { loadSettings } from '../config.js';
import { getDb, nowIso, rowToBoard } from '../db.js';
import { id } from '../util.js';
import { fetchActivityWatchHours, summarizeBoardHours } from '../services/hours.js';

const r = Router();

r.get('/:boardId', async (req, res) => {
  const row = getDb().prepare('SELECT * FROM boards WHERE id = ?').get(req.params.boardId);
  if (!row) return res.status(404).json({ error: 'Board not found' });
  const board = rowToBoard(row);
  const settings = loadSettings();
  const awCfg = settings.hours?.activityWatch || {};
  let aw = { ok: false, hours: 0, reason: 'ActivityWatch disabled' };

  if (awCfg.enabled) {
    aw = await fetchActivityWatchHours({
      baseUrl: awCfg.baseUrl,
      apps: awCfg.apps,
      titleKeyword: board.hoursAwFilter || '',
      startDate: board.hoursAwStart || null,
    });
  }

  const entries = getDb()
    .prepare('SELECT * FROM hour_entries WHERE board_id = ? ORDER BY created_at DESC')
    .all(req.params.boardId)
    .map((e) => ({
      id: e.id,
      source: e.source,
      hours: e.hours,
      note: e.note,
      startedAt: e.started_at,
      endedAt: e.ended_at,
      createdAt: e.created_at,
    }));

  const manualFromEntries = entries.filter((e) => e.source === 'manual').reduce((s, e) => s + e.hours, 0);
  const manual = Number(board.hoursManual || 0) + manualFromEntries;

  const summary = summarizeBoardHours({
    cap: board.hoursCap ?? settings.hours?.defaultCapHours ?? 30,
    manualHours: manual,
    awHours: aw.hours,
    awOk: !!aw.ok,
    awReason: aw.reason,
  });

  res.json({
    boardId: board.id,
    ...summary,
    activityWatch: aw,
    entries,
  });
});

r.post('/:boardId/entries', (req, res) => {
  const row = getDb().prepare('SELECT id FROM boards WHERE id = ?').get(req.params.boardId);
  if (!row) return res.status(404).json({ error: 'Board not found' });
  const hours = Number(req.body?.hours);
  if (!Number.isFinite(hours) || hours === 0) {
    return res.status(400).json({ error: 'hours must be a non-zero number' });
  }
  const entryId = id('hour');
  const ts = nowIso();
  getDb().prepare(`
    INSERT INTO hour_entries (id, board_id, source, hours, note, started_at, ended_at, created_at)
    VALUES (?, ?, 'manual', ?, ?, ?, ?, ?)
  `).run(
    entryId,
    req.params.boardId,
    hours,
    req.body?.note || '',
    req.body?.startedAt || null,
    req.body?.endedAt || null,
    ts,
  );
  res.status(201).json({ id: entryId, hours, createdAt: ts });
});

r.delete('/:boardId/entries/:entryId', (req, res) => {
  const info = getDb()
    .prepare('DELETE FROM hour_entries WHERE id = ? AND board_id = ?')
    .run(req.params.entryId, req.params.boardId);
  if (!info.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

export default r;
