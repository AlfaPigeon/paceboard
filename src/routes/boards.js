import { Router } from 'express';
import { getDb, nowIso, rowToBoard, rowToBeat, rowToCard, rowToGroup, rowToWire } from '../db.js';
import { loadSettings } from '../config.js';
import { id } from '../util.js';
import { analyzePacing } from '../services/pacing.js';

const r = Router();

function loadBoardBundle(boardId) {
  const db = getDb();
  const board = rowToBoard(db.prepare('SELECT * FROM boards WHERE id = ?').get(boardId));
  if (!board) return null;
  const cards = db.prepare('SELECT * FROM cards WHERE board_id = ?').all(boardId).map(rowToCard);
  const wires = db.prepare('SELECT * FROM wires WHERE board_id = ?').all(boardId).map(rowToWire);
  const groups = db.prepare('SELECT * FROM groups WHERE board_id = ?').all(boardId).map(rowToGroup);
  const beats = db.prepare('SELECT * FROM timeline_beats WHERE board_id = ? ORDER BY ord').all(boardId).map(rowToBeat);
  return { board, cards, wires, groups, beats };
}

r.get('/', (_req, res) => {
  const rows = getDb().prepare('SELECT * FROM boards ORDER BY updated_at DESC').all();
  res.json({ boards: rows.map(rowToBoard) });
});

r.post('/', (req, res) => {
  const db = getDb();
  const settings = loadSettings();
  const boardId = id('board');
  const ts = nowIso();
  const title = (req.body?.title || 'Untitled video').trim();
  const hoursCap = req.body?.hoursCap ?? settings.hours?.defaultCapHours ?? 30;
  db.prepare(`
    INSERT INTO boards (id, title, status, notion_page_id, notion_last_edited, target_runtime_sec,
      hours_cap, hours_manual, hours_aw_filter, hours_aw_start, audience_json, meta_json, created_at, updated_at)
    VALUES (?, ?, ?, NULL, NULL, ?, ?, 0, NULL, NULL, ?, '{}', ?, ?)
  `).run(
    boardId,
    title,
    req.body?.status || 'idea',
    Number(req.body?.targetRuntimeSec ?? 600),
    hoursCap,
    JSON.stringify(req.body?.audience || { who: '', alreadyKnow: '', promise: '', persona: '' }),
    ts,
    ts,
  );

  // Default audience card on canvas
  const cardId = id('card');
  db.prepare(`
    INSERT INTO cards (id, board_id, type, title, body, x, y, w, h, z, group_id, data_json, created_at, updated_at)
    VALUES (?, ?, 'audience', 'Audience', '', 40, 40, 280, 200, 1, NULL, ?, ?, ?)
  `).run(cardId, boardId, JSON.stringify({ syncWithBoard: true }), ts, ts);

  res.status(201).json(loadBoardBundle(boardId));
});

r.get('/:id', (req, res) => {
  const bundle = loadBoardBundle(req.params.id);
  if (!bundle) return res.status(404).json({ error: 'Board not found' });
  const pacing = analyzePacing({
    beats: bundle.beats,
    targetRuntimeSec: bundle.board.targetRuntimeSec,
  });
  res.json({ ...bundle, pacing });
});

r.patch('/:id', (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM boards WHERE id = ?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Board not found' });
  const b = req.body || {};
  db.prepare(`
    UPDATE boards SET
      title = COALESCE(?, title),
      status = COALESCE(?, status),
      target_runtime_sec = COALESCE(?, target_runtime_sec),
      hours_cap = COALESCE(?, hours_cap),
      hours_manual = COALESCE(?, hours_manual),
      hours_aw_filter = COALESCE(?, hours_aw_filter),
      hours_aw_start = COALESCE(?, hours_aw_start),
      audience_json = COALESCE(?, audience_json),
      meta_json = COALESCE(?, meta_json),
      notion_page_id = COALESCE(?, notion_page_id),
      notion_last_edited = COALESCE(?, notion_last_edited),
      updated_at = ?
    WHERE id = ?
  `).run(
    b.title ?? null,
    b.status ?? null,
    b.targetRuntimeSec ?? null,
    b.hoursCap ?? null,
    b.hoursManual ?? null,
    b.hoursAwFilter ?? null,
    b.hoursAwStart ?? null,
    b.audience ? JSON.stringify(b.audience) : null,
    b.meta ? JSON.stringify(b.meta) : null,
    b.notionPageId ?? null,
    b.notionLastEdited ?? null,
    nowIso(),
    req.params.id,
  );
  res.json(loadBoardBundle(req.params.id));
});

r.delete('/:id', (req, res) => {
  const info = getDb().prepare('DELETE FROM boards WHERE id = ?').run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: 'Board not found' });
  res.json({ ok: true });
});

/** Full-board autosave: replace cards/wires/groups/beats in one transaction. */
r.put('/:id/canvas', (req, res) => {
  const db = getDb();
  const boardId = req.params.id;
  if (!db.prepare('SELECT id FROM boards WHERE id = ?').get(boardId)) {
    return res.status(404).json({ error: 'Board not found' });
  }
  const { cards = [], wires = [], groups = [], beats = [], board: boardPatch } = req.body || {};
  const ts = nowIso();
  const tx = db.transaction(() => {
    if (boardPatch) {
      db.prepare(`
        UPDATE boards SET
          title = COALESCE(?, title),
          status = COALESCE(?, status),
          target_runtime_sec = COALESCE(?, target_runtime_sec),
          audience_json = COALESCE(?, audience_json),
          updated_at = ?
        WHERE id = ?
      `).run(
        boardPatch.title ?? null,
        boardPatch.status ?? null,
        boardPatch.targetRuntimeSec ?? null,
        boardPatch.audience ? JSON.stringify(boardPatch.audience) : null,
        ts,
        boardId,
      );
    }

    db.prepare('DELETE FROM wires WHERE board_id = ?').run(boardId);
    db.prepare('DELETE FROM timeline_beats WHERE board_id = ?').run(boardId);
    db.prepare('DELETE FROM cards WHERE board_id = ?').run(boardId);
    db.prepare('DELETE FROM groups WHERE board_id = ?').run(boardId);

    const insGroup = db.prepare(`
      INSERT INTO groups (id, board_id, title, x, y, w, h, color, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const g of groups) {
      insGroup.run(
        g.id || id('group'), boardId, g.title || 'Section',
        g.x || 0, g.y || 0, g.w || 480, g.h || 320, g.color || '#334155',
        JSON.stringify(g.data || {}), ts, ts,
      );
    }

    const insCard = db.prepare(`
      INSERT INTO cards (id, board_id, type, title, body, x, y, w, h, z, group_id, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of cards) {
      insCard.run(
        c.id || id('card'), boardId, c.type || 'note', c.title || '', c.body || '',
        c.x || 0, c.y || 0, c.w || 240, c.h || 140, c.z || 0, c.groupId || null,
        JSON.stringify(c.data || {}), ts, ts,
      );
    }

    const insWire = db.prepare(`
      INSERT INTO wires (id, board_id, from_card_id, to_card_id, kind, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const w of wires) {
      if (!w.fromCardId || !w.toCardId) continue;
      const wid = w.id || id('wire');
      db.prepare('DELETE FROM wires WHERE id = ?').run(wid);
      insWire.run(
        wid, boardId, w.fromCardId, w.toCardId, w.kind || 'flow',
        JSON.stringify(w.data || {}), ts,
      );
    }

    const insBeat = db.prepare(`
      INSERT INTO timeline_beats (id, board_id, card_id, ord, label, planned_sec, clip_in_sec, clip_out_sec, serves_promise, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    beats.forEach((b, i) => {
      insBeat.run(
        b.id || id('beat'), boardId, b.cardId || null, b.ord ?? i,
        b.label || '', Number(b.plannedSec ?? 30),
        b.clipInSec ?? null, b.clipOutSec ?? null,
        b.servesPromise === false ? 0 : 1,
        JSON.stringify(b.data || {}), ts, ts,
      );
    });

    db.prepare('UPDATE boards SET updated_at = ? WHERE id = ?').run(ts, boardId);
  });
  tx();
  const bundle = loadBoardBundle(boardId);
  const pacing = analyzePacing({ beats: bundle.beats, targetRuntimeSec: bundle.board.targetRuntimeSec });
  res.json({ ...bundle, pacing });
});

r.get('/:id/pacing', (req, res) => {
  const bundle = loadBoardBundle(req.params.id);
  if (!bundle) return res.status(404).json({ error: 'Board not found' });
  res.json(analyzePacing({
    beats: bundle.beats,
    targetRuntimeSec: bundle.board.targetRuntimeSec,
    hookWindowSec: Number(req.query.hookWindowSec || 15),
  }));
});

export default r;
export { loadBoardBundle };
