import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { MEDIA_DIR, UPLOAD_DIR } from '../config.js';
import {
  enqueueMediaProcess,
  getMedia,
  listMedia,
  scenesToClipCards,
} from '../services/media.js';
import { getDb, nowIso } from '../db.js';
import { id } from '../util.js';

const upload = multer({ dest: UPLOAD_DIR });
const r = Router();

r.get('/', (req, res) => {
  res.json({ media: listMedia(req.query.boardId || null) });
});

r.get('/:id', (req, res) => {
  const media = getMedia(req.params.id);
  if (!media) return res.status(404).json({ error: 'Not found' });
  res.json(media);
});

r.post('/import-path', (req, res) => {
  try {
    const sourcePath = req.body?.path;
    const boardId = req.body?.boardId || null;
    const result = enqueueMediaProcess({ sourcePath, boardId });
    res.status(result.cached ? 200 : 202).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

r.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    const dest = path.join(UPLOAD_DIR, req.file.originalname || req.file.filename);
    fs.renameSync(req.file.path, dest);
    const result = enqueueMediaProcess({ sourcePath: dest, boardId: req.body?.boardId || null });
    res.status(202).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

r.get('/:id/proxy', (req, res) => {
  const media = getMedia(req.params.id);
  if (!media?.proxyPath || !fs.existsSync(media.proxyPath)) {
    return res.status(404).json({ error: 'Proxy not ready' });
  }
  res.sendFile(path.resolve(media.proxyPath));
});

r.get('/:id/file', (req, res) => {
  const media = getMedia(req.params.id);
  if (!media) return res.status(404).json({ error: 'Not found' });
  const rel = req.query.path;
  if (!rel) return res.status(400).json({ error: 'path required' });
  const abs = path.resolve(MEDIA_DIR, path.normalize(String(rel)));
  if (!abs.startsWith(path.resolve(MEDIA_DIR, media.id))) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Missing file' });
  res.sendFile(abs);
});

r.post('/:id/clip-cards', (req, res) => {
  const media = getMedia(req.params.id);
  if (!media) return res.status(404).json({ error: 'Not found' });
  const boardId = req.body?.boardId || media.boardId;
  if (!boardId) return res.status(400).json({ error: 'boardId required' });
  const cards = scenesToClipCards(media, req.body?.origin || { x: 120, y: 120 });
  const db = getDb();
  const ts = nowIso();
  const created = [];
  const ins = db.prepare(`
    INSERT INTO cards (id, board_id, type, title, body, x, y, w, h, z, group_id, data_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)
  `);
  const tx = db.transaction(() => {
    for (const c of cards) {
      const cardId = id('card');
      ins.run(cardId, boardId, c.type, c.title, c.body, c.x, c.y, c.w, c.h, JSON.stringify(c.data), ts, ts);
      created.push({ ...c, id: cardId, boardId });
    }
    db.prepare('UPDATE boards SET updated_at = ? WHERE id = ?').run(ts, boardId);
  });
  tx();
  res.status(201).json({ cards: created });
});

export default r;
