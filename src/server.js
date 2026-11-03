import express from 'express';
import path from 'node:path';
import { DEFAULT_PORT, HOST, ROOT, loadSettings } from './config.js';
import { getDb } from './db.js';
import boards from './routes/boards.js';
import settings from './routes/settings.js';
import notion from './routes/notion.js';
import media from './routes/media.js';
import files from './routes/files.js';
import exportRoutes from './routes/export.js';
import hours from './routes/hours.js';
import { getJob, cancelJob } from './services/jobs.js';
import './services/media.js'; // register job handlers

const app = express();
app.use(express.json({ limit: '12mb' }));
app.use(express.static(path.join(ROOT, 'public')));

getDb();
loadSettings();

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, name: 'cutline', port: Number(process.env.STORYBOARD_PORT || DEFAULT_PORT) });
});

app.use('/api/boards', boards);
app.use('/api/settings', settings);
app.use('/api/notion', notion);
app.use('/api/media', media);
app.use('/api/files', files);
app.use('/api/export', exportRoutes);
app.use('/api/hours', hours);

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});
app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = cancelJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

// SPA: board deep links land on the framed-sheet app
app.get(['/board', '/board.html'], (_req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'index.html'));
});

const port = Number(process.env.STORYBOARD_PORT || DEFAULT_PORT);
if (process.env.STORYBOARD_NO_LISTEN !== '1') {
  app.listen(port, HOST, () => {
    console.log(`Cutline listening on http://${HOST}:${port}`);
  });
}

export default app;
