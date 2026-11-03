import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR, MEDIA_DIR, loadSettings } from '../config.js';
import { getDb, nowIso, safeJson } from '../db.js';
import { id, parseFfprobe, runCmd, sha256File } from '../util.js';
import { enqueueJob, registerJobHandler, updateJob } from './jobs.js';

registerJobHandler('media_process', processMediaJob);

export function listMedia(boardId) {
  const rows = boardId
    ? getDb().prepare('SELECT * FROM media_assets WHERE board_id = ? ORDER BY created_at DESC').all(boardId)
    : getDb().prepare('SELECT * FROM media_assets ORDER BY created_at DESC').all();
  return rows.map(rowToMedia);
}

export function getMedia(mediaId) {
  return rowToMedia(getDb().prepare('SELECT * FROM media_assets WHERE id = ?').get(mediaId));
}

export function enqueueMediaProcess({ sourcePath, boardId = null }) {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error(`Source not found: ${sourcePath}`);
  }
  const st = fs.statSync(sourcePath);
  const hash = sha256File(sourcePath);
  const existing = getDb()
    .prepare('SELECT * FROM media_assets WHERE source_hash = ? AND source_mtime = ? AND status = ?')
    .get(hash, st.mtimeMs, 'ready');
  if (existing) {
    return { cached: true, media: rowToMedia(existing), job: null };
  }

  const mediaId = id('media');
  const ts = nowIso();
  getDb().prepare(`
    INSERT INTO media_assets
    (id, board_id, source_path, source_hash, source_mtime, duration_sec, probe_json, proxy_path,
     thumbs_json, waveform_json, scenes_json, status, progress, error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, NULL, '{}', NULL, '[]', '[]', '[]', 'pending', 0, NULL, ?, ?)
  `).run(mediaId, boardId, path.resolve(sourcePath), hash, st.mtimeMs, ts, ts);

  const job = enqueueJob('media_process', { mediaId });
  return { cached: false, media: getMedia(mediaId), job };
}

async function processMediaJob(payload, ctx) {
  const { mediaId } = payload;
  const db = getDb();
  const row = db.prepare('SELECT * FROM media_assets WHERE id = ?').get(mediaId);
  if (!row) throw new Error('media not found');
  const settings = loadSettings().media || {};
  const outDir = path.join(MEDIA_DIR, mediaId);
  fs.mkdirSync(outDir, { recursive: true });

  const setStatus = (status, progress, extra = {}) => {
    db.prepare(`
      UPDATE media_assets SET status=?, progress=?, duration_sec=COALESCE(?, duration_sec),
        probe_json=COALESCE(?, probe_json), proxy_path=COALESCE(?, proxy_path),
        thumbs_json=COALESCE(?, thumbs_json), waveform_json=COALESCE(?, waveform_json),
        scenes_json=COALESCE(?, scenes_json), error=?, updated_at=?
      WHERE id=?
    `).run(
      status,
      progress,
      extra.duration ?? null,
      extra.probeJson ?? null,
      extra.proxyPath ?? null,
      extra.thumbsJson ?? null,
      extra.waveformJson ?? null,
      extra.scenesJson ?? null,
      extra.error ?? null,
      nowIso(),
      mediaId,
    );
    ctx.setProgress?.(progress);
  };

  try {
    if (ctx.isCancelled?.()) throw Object.assign(new Error('cancelled'), { cancelled: true });
    setStatus('probing', 0.05);
    const probeRaw = await runCmd('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', row.source_path,
    ], { signal: ctx.signal });
    const probe = parseFfprobe(probeRaw.stdout);
    setStatus('probing', 0.1, { duration: probe.duration, probeJson: JSON.stringify(probe) });

    if (ctx.isCancelled?.()) throw Object.assign(new Error('cancelled'), { cancelled: true });
    setStatus('proxy', 0.15);
    const proxyPath = path.join(outDir, 'proxy.mp4');
    await makeProxy(row.source_path, proxyPath, settings, ctx);
    setStatus('proxy', 0.55, { proxyPath });

    if (ctx.isCancelled?.()) throw Object.assign(new Error('cancelled'), { cancelled: true });
    setStatus('thumbs', 0.6);
    const thumbs = await makeThumbs(row.source_path, outDir, probe.duration, settings, ctx);
    setStatus('thumbs', 0.75, { thumbsJson: JSON.stringify(thumbs) });

    if (ctx.isCancelled?.()) throw Object.assign(new Error('cancelled'), { cancelled: true });
    setStatus('waveform', 0.8);
    const peaks = await makeWaveform(row.source_path, outDir, ctx);
    setStatus('waveform', 0.9, { waveformJson: JSON.stringify(peaks) });

    if (ctx.isCancelled?.()) throw Object.assign(new Error('cancelled'), { cancelled: true });
    setStatus('scenes', 0.92);
    const scenes = await detectScenes(row.source_path, settings, ctx);
    setStatus('ready', 1, { scenesJson: JSON.stringify(scenes) });

    return { mediaId, proxyPath, thumbs: thumbs.length, scenes: scenes.length, peaks: peaks.length };
  } catch (err) {
    if (err.cancelled || ctx.signal?.aborted) {
      setStatus('cancelled', 0, { error: 'cancelled' });
      throw err;
    }
    setStatus('error', 0, { error: err.message || String(err) });
    throw err;
  }
}

async function makeProxy(src, dest, settings, ctx) {
  const h = settings.proxyHeight || 720;
  const vbit = settings.proxyVideoBitrate || '2500k';
  const abit = settings.proxyAudioBitrate || '128k';
  // Scale to 720p height, even dims, H.264 + AAC. Never touch source.
  await runCmd('ffmpeg', [
    '-y', '-i', src,
    '-vf', `scale=-2:${h}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', vbit, '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', abit,
    '-movflags', '+faststart',
    dest,
  ], { signal: ctx.signal });
}

async function makeThumbs(src, outDir, duration, settings, ctx) {
  const interval = Math.max(1, Number(settings.thumbIntervalSec || 2));
  const thumbDir = path.join(outDir, 'thumbs');
  fs.mkdirSync(thumbDir, { recursive: true });
  const pattern = path.join(thumbDir, 't_%05d.jpg');
  await runCmd('ffmpeg', [
    '-y', '-i', src,
    '-vf', `fps=1/${interval},scale=160:-1`,
    '-q:v', '5',
    pattern,
  ], { signal: ctx.signal });
  const files = fs.readdirSync(thumbDir).filter((f) => f.endsWith('.jpg')).sort();
  return files.map((f, i) => ({
    t: i * interval,
    path: path.join(thumbDir, f),
    url: null, // filled by API
  }));
}

async function makeWaveform(src, outDir, ctx) {
  const rawPath = path.join(outDir, 'wave.f32');
  // mono f32 pcm at 8000 Hz — then downsample peaks in JS
  try {
    await runCmd('ffmpeg', [
      '-y', '-i', src,
      '-ac', '1', '-ar', '8000', '-f', 'f32le',
      rawPath,
    ], { signal: ctx.signal });
  } catch {
    return []; // no audio
  }
  const buf = fs.readFileSync(rawPath);
  const samples = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
  const buckets = 400;
  const peaks = [];
  const per = Math.max(1, Math.floor(samples.length / buckets));
  for (let i = 0; i < buckets; i++) {
    let peak = 0;
    const start = i * per;
    const end = Math.min(samples.length, start + per);
    for (let j = start; j < end; j++) peak = Math.max(peak, Math.abs(samples[j]));
    peaks.push(Number(peak.toFixed(4)));
  }
  try { fs.unlinkSync(rawPath); } catch {}
  return peaks;
}

async function detectScenes(src, settings, ctx) {
  const thr = settings.sceneThreshold ?? 0.35;
  let stderr = '';
  try {
    await runCmd('ffmpeg', [
      '-i', src,
      '-filter:v', `select='gt(scene,${thr})',showinfo`,
      '-f', 'null', '-',
    ], {
      signal: ctx.signal,
      onStderr: (chunk) => { stderr += chunk; },
    });
  } catch (err) {
    stderr += err.stderr || '';
  }
  const times = [0];
  const re = /pts_time:([0-9.]+)/g;
  let m;
  while ((m = re.exec(stderr))) {
    const t = Number(m[1]);
    if (!Number.isNaN(t)) times.push(t);
  }
  times.sort((a, b) => a - b);
  const uniq = [];
  for (const t of times) {
    if (!uniq.length || t - uniq[uniq.length - 1] > 0.4) uniq.push(t);
  }
  const scenes = [];
  for (let i = 0; i < uniq.length; i++) {
    const inn = uniq[i];
    const out = i + 1 < uniq.length ? uniq[i + 1] : null;
    scenes.push({ index: i, in: inn, out, label: `Scene ${i + 1}` });
  }
  return scenes;
}

export function scenesToClipCards(media, origin = { x: 100, y: 100 }) {
  const scenes = media.scenes || [];
  return scenes.map((s, i) => ({
    type: 'clip',
    title: s.label || `Scene ${i + 1}`,
    body: '',
    x: origin.x + (i % 4) * 260,
    y: origin.y + Math.floor(i / 4) * 180,
    w: 240,
    h: 160,
    data: {
      mediaId: media.id,
      sourcePath: media.sourcePath,
      inSec: s.in,
      outSec: s.out,
      proxyUrl: media.proxyUrl,
    },
  }));
}

function rowToMedia(row) {
  if (!row) return null;
  const thumbs = safeJson(row.thumbs_json, []).map((t) => ({
    ...t,
    url: t.path ? `/api/media/${row.id}/file?path=${encodeURIComponent(path.relative(MEDIA_DIR, t.path))}` : null,
  }));
  return {
    id: row.id,
    boardId: row.board_id,
    sourcePath: row.source_path,
    sourceHash: row.source_hash,
    sourceMtime: row.source_mtime,
    durationSec: row.duration_sec,
    probe: safeJson(row.probe_json, {}),
    proxyPath: row.proxy_path,
    proxyUrl: row.proxy_path ? `/api/media/${row.id}/proxy` : null,
    thumbs,
    waveform: safeJson(row.waveform_json, []),
    scenes: safeJson(row.scenes_json, []),
    status: row.status,
    progress: row.progress,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export { processMediaJob };
