import { Router } from 'express';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '../config.js';

const r = Router();

r.get('/', (_req, res) => {
  const s = loadSettings();
  res.json(publicSettings(s));
});

r.put('/', (req, res) => {
  const cur = loadSettings();
  const body = req.body || {};
  const next = {
    ...cur,
    ...body,
    notion: { ...cur.notion, ...(body.notion || {}) },
    hours: {
      ...cur.hours,
      ...(body.hours || {}),
      activityWatch: {
        ...cur.hours.activityWatch,
        ...(body.hours?.activityWatch || {}),
      },
    },
    media: { ...cur.media, ...(body.media || {}) },
  };
  const saved = saveSettings(next);
  res.json(publicSettings(saved));
});

r.get('/defaults', (_req, res) => {
  res.json(publicSettings(DEFAULT_SETTINGS));
});

function publicSettings(s) {
  return {
    ...s,
    notion: {
      ...s.notion,
      token: s.notion?.token ? '••••' + String(s.notion.token).slice(-4) : '',
      tokenSet: !!s.notion?.token,
    },
  };
}

export default r;
