import { Router } from 'express';
import { boardToJsonBundle, boardToMarkdown } from '../services/export.js';
import { getDb, nowIso, rowToBoard } from '../db.js';
import { id } from '../util.js';
import { loadBoardBundle } from './boards.js';

const r = Router();

r.get('/:id/markdown', (req, res) => {
  const bundle = loadBoardBundle(req.params.id);
  if (!bundle) return res.status(404).json({ error: 'Board not found' });
  const md = boardToMarkdown(bundle);
  res.type('text/markdown').send(md);
});

r.get('/:id/json', (req, res) => {
  const bundle = loadBoardBundle(req.params.id);
  if (!bundle) return res.status(404).json({ error: 'Board not found' });
  res.json(boardToJsonBundle(bundle));
});

r.post('/import', (req, res) => {
  const data = req.body;
  if (!data?.board) return res.status(400).json({ error: 'Invalid board export' });
  const db = getDb();
  const ts = nowIso();
  const boardId = id('board');
  const b = data.board;
  db.prepare(`
    INSERT INTO boards (id, title, status, notion_page_id, notion_last_edited, target_runtime_sec,
      hours_cap, hours_manual, hours_aw_filter, hours_aw_start, audience_json, meta_json, created_at, updated_at)
    VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    boardId,
    b.title || 'Imported board',
    b.status || 'idea',
    b.targetRuntimeSec ?? 600,
    b.hoursCap ?? 30,
    b.hoursManual ?? 0,
    b.hoursAwFilter ?? null,
    b.hoursAwStart ?? null,
    JSON.stringify(b.audience || {}),
    JSON.stringify(b.meta || {}),
    ts,
    ts,
  );

  const idMap = new Map();
  const mapId = (old, prefix) => {
    if (!old) return null;
    if (!idMap.has(old)) idMap.set(old, id(prefix));
    return idMap.get(old);
  };

  const tx = db.transaction(() => {
    for (const g of data.groups || []) {
      const gid = mapId(g.id, 'group');
      db.prepare(`
        INSERT INTO groups (id, board_id, title, x, y, w, h, color, data_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(gid, boardId, g.title || 'Section', g.x||0, g.y||0, g.w||480, g.h||320, g.color||'#334155', JSON.stringify(g.data||{}), ts, ts);
    }
    for (const c of data.cards || []) {
      const cid = mapId(c.id, 'card');
      db.prepare(`
        INSERT INTO cards (id, board_id, type, title, body, x, y, w, h, z, group_id, data_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(cid, boardId, c.type||'note', c.title||'', c.body||'', c.x||0, c.y||0, c.w||240, c.h||140, c.z||0, c.groupId ? mapId(c.groupId, 'group') : null, JSON.stringify(c.data||{}), ts, ts);
    }
    for (const w of data.wires || []) {
      db.prepare(`
        INSERT INTO wires (id, board_id, from_card_id, to_card_id, kind, data_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id('wire'), boardId, mapId(w.fromCardId, 'card'), mapId(w.toCardId, 'card'), w.kind||'flow', JSON.stringify(w.data||{}), ts);
    }
    (data.beats || []).forEach((beat, i) => {
      db.prepare(`
        INSERT INTO timeline_beats (id, board_id, card_id, ord, label, planned_sec, clip_in_sec, clip_out_sec, serves_promise, data_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id('beat'), boardId, beat.cardId ? mapId(beat.cardId, 'card') : null, beat.ord ?? i, beat.label||'', beat.plannedSec??30, beat.clipInSec??null, beat.clipOutSec??null, beat.servesPromise===false?0:1, JSON.stringify(beat.data||{}), ts, ts);
    });
  });
  tx();
  res.status(201).json(loadBoardBundle(boardId));
});

export default r;
