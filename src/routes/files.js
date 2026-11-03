import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';

const r = Router();

const VIDEO_EXT = new Set(['.mkv', '.mov', '.mp4', '.webm', '.avi', '.m4v', '.mxf', '.mpg', '.mpeg']);

r.get('/browse', (req, res) => {
  try {
    let dir = req.query.path ? String(req.query.path) : os.homedir();
    dir = path.resolve(dir);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Path not found' });
    const st = fs.statSync(dir);
    if (!st.isDirectory()) dir = path.dirname(dir);
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => {
        const full = path.join(dir, e.name);
        let size = null;
        let mtime = null;
        try {
          const s = fs.statSync(full);
          size = s.size;
          mtime = s.mtimeMs;
        } catch {}
        const ext = path.extname(e.name).toLowerCase();
        return {
          name: e.name,
          path: full,
          isDir: e.isDirectory(),
          isVideo: !e.isDirectory() && VIDEO_EXT.has(ext),
          size,
          mtime,
        };
      })
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));

    res.json({
      path: dir,
      parent: path.dirname(dir),
      entries,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default r;
