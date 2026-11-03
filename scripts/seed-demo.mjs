#!/usr/bin/env node
/**
 * Seed a non-personal demo board for screenshots / local preview.
 * Reads scripts/demo-board.json (no shell interpolation) and generates
 * short lavfi demo clips so the Clips panel matches the timeline.
 *
 * Usage:
 *   node scripts/seed-demo.mjs
 *   PACEBOARD_BASE=http://127.0.0.1:3200 node scripts/seed-demo.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, 'demo-board.json'), 'utf8'));
const BASE = process.env.PACEBOARD_BASE || 'http://127.0.0.1:3200';
const MEDIA_DIR = path.join(ROOT, 'fixtures', 'demo-media');

async function api(method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${urlPath} → ${res.status}: ${text.slice(0, 400)}`);
  return data;
}

function makeDemoClip(dest, { color, seconds, container }) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const args = [
    '-y',
    '-f', 'lavfi', '-i', `color=c=${color}:s=640x360:d=${seconds}`,
    '-f', 'lavfi', '-i', `sine=f=440:d=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
  ];
  if (container === 'mov') {
    // QuickTime-friendly MOV container (still H.264; fine for demo proxy pipeline)
    args.push('-movflags', '+faststart');
  }
  args.push(dest);
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed for ${dest}: ${r.stderr?.slice(-400)}`);
}

async function waitJob(jobId, timeoutMs = 120000) {
  if (!jobId) return null;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const job = await api('GET', `/api/jobs/${jobId}`);
    if (['done', 'error', 'cancelled'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`job ${jobId} timed out`);
}


async function forceBuildingClip(_boardId, mediaRows) {
  // Leave one clip mid-proxy so the Clips panel shows "Building …%" in screenshots.
  const pick = mediaRows.find((m) => /building|inprogress|desk/i.test(m.sourcePath || '')) || mediaRows[0];
  if (!pick) return;
  const dataDir = process.env.PACEBOARD_DATA || path.join(ROOT, 'data');
  const dbPath = process.env.PACEBOARD_DB || path.join(dataDir, 'paceboard.sqlite');
  const tmp = path.join(MEDIA_DIR, '_force-building.cjs');
  const body = [
    "const Database = require('better-sqlite3');",
    `const db = new Database(${JSON.stringify(dbPath)});`,
    "db.prepare(\"UPDATE media_assets SET status='proxy', progress=0.42, updated_at=? WHERE id=?\")"
      + `.run(new Date().toISOString(), ${JSON.stringify(pick.id)});`,
    'db.close();',
    `console.log('forced building', ${JSON.stringify(pick.id)});`,
    '',
  ].join('\n');
  fs.writeFileSync(tmp, body);
  const r = spawnSync(process.execPath, [tmp], { encoding: 'utf8', cwd: ROOT });
  try { fs.unlinkSync(tmp); } catch {}
  if (r.status !== 0) console.warn('forceBuildingClip failed', r.stderr || r.stdout);
  else console.log(String(r.stdout || '').trim());
}

async function main() {
  // Sanity: dollar signs must survive JSON → memory (guards against bad re-exports)
  if (!SPEC.board.audience.promise.includes('$200')) {
    throw new Error('demo-board.json promise lost $200 before seed');
  }
  if (!SPEC.board.title.includes('$200')) {
    throw new Error('demo-board.json title lost $200 before seed');
  }

  console.log('==> Generating lavfi demo media in', MEDIA_DIR);
  for (const m of SPEC.media) {
    const dest = path.join(MEDIA_DIR, m.file);
    const container = m.file.endsWith('.mov') ? 'mov' : 'mkv';
    makeDemoClip(dest, { color: m.color, seconds: m.seconds, container });
    console.log('   ', m.file);
  }

  // Wipe existing boards so screenshots are deterministic
  const list = await api('GET', '/api/boards');
  for (const b of list.boards || []) {
    await api('DELETE', `/api/boards/${b.id}`);
  }

  console.log('==> Creating board');
  const created = await api('POST', '/api/boards', {
    title: SPEC.board.title,
    status: SPEC.board.status,
    targetRuntimeSec: SPEC.board.targetRuntimeSec,
    hoursCap: SPEC.board.hoursCap,
    hoursManual: SPEC.board.hoursManual,
    audience: SPEC.board.audience,
    meta: SPEC.board.meta,
  });
  const boardId = created.board?.id || created.id;
  if (!boardId) throw new Error('create board returned no id: ' + JSON.stringify(created));

  // Patch audience/title again via JSON body (explicit $200 round-trip)
  await api('PATCH', `/api/boards/${boardId}`, {
    title: SPEC.board.title,
    status: SPEC.board.status,
    targetRuntimeSec: SPEC.board.targetRuntimeSec,
    hoursCap: SPEC.board.hoursCap,
    hoursManual: SPEC.board.hoursManual,
    audience: SPEC.board.audience,
    meta: SPEC.board.meta,
  });

  const bundle = await api('GET', `/api/boards/${boardId}`);
  const promise = bundle.board.audience?.promise || '';
  if (!promise.includes('$200')) {
    throw new Error(`API mangled promise: ${JSON.stringify(promise)}`);
  }

  // Build canvas: keep default audience card, add beats + note
  let audienceCard = (bundle.cards || []).find((c) => c.type === 'audience');
  const cards = [];
  const wires = [];
  const beats = [];
  const layout = SPEC.layout;
  const ts = new Date().toISOString();

  if (!audienceCard) {
    audienceCard = {
      id: `card_aud_demo`,
      type: 'audience',
      title: 'Audience',
      body: '',
      ...layout.Audience,
      z: 0,
      data: { syncWithBoard: true },
    };
  } else {
    audienceCard = {
      ...audienceCard,
      ...layout.Audience,
      title: 'Audience',
      data: { ...(audienceCard.data || {}), syncWithBoard: true },
    };
  }
  cards.push(audienceCard);

  const beatCards = [];
  for (const b of SPEC.beats) {
    const loc = layout[b.label] || { x: 100, y: 100, w: 200, h: 108 };
    const cardId = `card_demo_${b.label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    const beatId = `beat_demo_${b.label.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
    const card = {
      id: cardId,
      type: 'beat',
      title: b.label,
      body: '',
      x: loc.x,
      y: loc.y,
      w: loc.w,
      h: loc.h,
      z: 0,
      data: { beatId, plannedSec: b.plannedSec, fit: b.fit },
    };
    cards.push(card);
    beatCards.push(card);
    beats.push({
      id: beatId,
      cardId,
      ord: beats.length,
      label: b.label,
      plannedSec: b.plannedSec,
      clipInSec: null,
      clipOutSec: null,
      servesPromise: b.servesPromise,
      data: {
        targetSec: b.targetSec,
        clips: b.clips.map((label) => ({ label })),
        fit: b.fit,
      },
    });
  }

  const noteLoc = layout['Leave-behind'];
  cards.push({
    id: 'card_demo_note',
    type: 'note',
    title: 'Leave-behind',
    body: SPEC.noteBody,
    x: noteLoc.x,
    y: noteLoc.y,
    w: noteLoc.w,
    h: noteLoc.h,
    z: 0,
    data: {},
  });

  for (let i = 0; i < beatCards.length - 1; i++) {
    wires.push({
      id: `wire_demo_${i}`,
      fromCardId: beatCards[i].id,
      toCardId: beatCards[i + 1].id,
      kind: 'flow',
      data: {},
    });
  }

  await api('PUT', `/api/boards/${boardId}/canvas`, { cards, wires, groups: [], beats });

  console.log('==> Importing demo media');
  const readyJobs = [];
  let pendingMedia = null;
  for (const m of SPEC.media) {
    const sourcePath = path.join(MEDIA_DIR, m.file);
    const result = await api('POST', '/api/media/import-path', { path: sourcePath, boardId });
    if (m.ready) {
      if (!result.cached && result.job?.id) readyJobs.push(result.job.id);
      console.log('   queued ready', m.file, result.media?.id);
    } else {
      pendingMedia = result.media;
      console.log('   leave in-progress', m.file, result.media?.id, 'job', result.job?.id);
      // Do not await this job — leave it processing for the Clips panel
    }
  }

  for (const jid of readyJobs) {
    const job = await waitJob(jid);
    if (job.status !== 'done') throw new Error(`media job failed: ${JSON.stringify(job)}`);
  }

  // Keep one clip in a non-ready pipeline state for the Clips panel ("Building…")
  if (pendingMedia?.id) {
    const started = Date.now();
    let media = await api('GET', `/api/media/${pendingMedia.id}`);
    while (media.status === 'pending' && Date.now() - started < 15000) {
      await new Promise((r) => setTimeout(r, 200));
      media = await api('GET', `/api/media/${pendingMedia.id}`);
    }
    if (media.status === 'ready') {
      // Finished too fast (tiny file / fast CPU): insert a synthetic building row via re-import of a fresh longer clip
      const extra = path.join(MEDIA_DIR, 'broll-desk-building.mkv');
      makeDemoClip(extra, { color: '0x555555', seconds: 30, container: 'mkv' });
      const result = await api('POST', '/api/media/import-path', { path: extra, boardId });
      pendingMedia = result.media;
      const t2 = Date.now();
      media = pendingMedia;
      while (media && (media.status === 'pending' || media.status === 'ready') && Date.now() - t2 < 20000) {
        await new Promise((r) => setTimeout(r, 150));
        media = await api('GET', `/api/media/${pendingMedia.id}`);
        if (media.status !== 'ready' && media.status !== 'pending') break;
      }
    }
    console.log('   in-progress status:', media?.status, 'progress', media?.progress);
  }

  const final = await api('GET', `/api/boards/${boardId}`);
  const mediaList = await api('GET', `/api/media?boardId=${encodeURIComponent(boardId)}`);
  const planned = (final.beats || []).reduce((s, b) => s + (b.plannedSec || 0), 0);
  console.log('==> Seeded', boardId);
  console.log('    title:', final.board.title);
  console.log('    promise:', final.board.audience.promise);
  console.log('    plannedSec:', planned, `(${Math.floor(planned / 60)}:${String(planned % 60).padStart(2, '0')})`);
  console.log('    media:', (mediaList.media || []).map((m) => `${path.basename(m.sourcePath)}:${m.status}`).join(', '));
  if (!final.board.audience.promise.includes('$200')) {
    throw new Error('final promise missing $200');
  }
  
  // Guarantee one Clips-panel "Building…" row for screenshots even on fast machines
  await forceBuildingClip(boardId, mediaList.media || []);

  if (planned !== 760) throw new Error(`expected planned 760, got ${planned}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
