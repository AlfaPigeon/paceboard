import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const DATA_DIR = process.env.STORYBOARD_DATA || path.join(ROOT, 'data');
export const DB_PATH = process.env.STORYBOARD_DB || path.join(DATA_DIR, 'storyboard.sqlite');
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const CACHE_DIR = path.join(DATA_DIR, 'cache');
export const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');

export const DEFAULT_PORT = Number(process.env.STORYBOARD_PORT || 3200);
export const HOST = process.env.STORYBOARD_HOST || '127.0.0.1';

export const DEFAULT_SETTINGS = {
  notion: {
    token: '',
    databaseId: '',
    mapping: {
      title: 'Video', // also Name/Title via suggestMapping
      stage: 'Stage',
      persona: 'Persona',
      leave_behind: 'Leave-behind',
      link: 'Link',
      target_week: 'Target week',
      target_runtime: '',
    },
    mappingConfirmed: false,
  },
  hours: {
    defaultCapHours: 30,
    activityWatch: {
      enabled: false,
      baseUrl: 'http://localhost:5600',
      apps: ['DaVinci Resolve', 'resolve', 'OBS', 'obs'],
    },
  },
  media: {
    proxyHeight: 720,
    proxyVideoBitrate: '2500k',
    proxyAudioBitrate: '128k',
    thumbIntervalSec: 2,
    sceneThreshold: 0.35,
  },
};

for (const dir of [DATA_DIR, MEDIA_DIR, UPLOAD_DIR, CACHE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

export function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) return structuredClone(DEFAULT_SETTINGS);
    const raw = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    return deepMerge(structuredClone(DEFAULT_SETTINGS), raw);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(next) {
  const merged = deepMerge(structuredClone(DEFAULT_SETTINGS), next || {});
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2));
  return merged;
}

function deepMerge(base, over) {
  if (!over || typeof over !== 'object') return base;
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}
