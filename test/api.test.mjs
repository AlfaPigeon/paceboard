import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paceboard-api-'));
process.env.PACEBOARD_DATA = tmp;
process.env.PACEBOARD_DB = path.join(tmp, 'test.sqlite');
process.env.PACEBOARD_NO_LISTEN = '1';
process.env.PACEBOARD_PORT = '3210';

const { default: app } = await import('../src/server.js');

function listen(app) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function req(base, method, p, body) {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { status: res.status, data };
}

test('health + board CRUD + canvas autosave + pacing + export', async (t) => {
  const ctx = await listen(app);
  t.after(() => ctx.close());

  const health = await req(ctx.url, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.ok, true);

  const created = await req(ctx.url, 'POST', '/api/boards', { title: 'Test video', targetRuntimeSec: 120 });
  assert.equal(created.status, 201);
  assert.equal(created.data.board.title, 'Test video');
  assert.ok(created.data.cards.some((c) => c.type === 'audience'));
  const id = created.data.board.id;

  const canvas = await req(ctx.url, 'PUT', `/api/boards/${id}/canvas`, {
    board: { title: 'Test video', targetRuntimeSec: 120, audience: { who: 'devs', promise: 'ship faster', alreadyKnow: 'git', persona: 'builder' } },
    cards: [
      ...created.data.cards,
      { id: 'card_beat1', type: 'beat', title: 'Hook', body: 'cold open', x: 100, y: 100, w: 240, h: 140, data: {} },
      { id: 'card_note1', type: 'note', title: 'Talking', body: 'explain', x: 400, y: 100, w: 240, h: 140, data: { kind: 'talking', visualChange: false } },
    ],
    wires: [{ id: 'wire1', fromCardId: 'card_beat1', toCardId: 'card_note1', kind: 'flow' }],
    groups: [{ id: 'group1', title: 'Act 1', x: 50, y: 50, w: 700, h: 400 }],
    beats: [
      { id: 'beat1', cardId: 'card_beat1', ord: 0, label: 'Hook', plannedSec: 20, servesPromise: true },
      { id: 'beat2', cardId: 'card_note1', ord: 1, label: 'Talk', plannedSec: 90, servesPromise: false, data: { kind: 'talking', visualChange: false } },
    ],
  });
  assert.equal(canvas.status, 200);
  assert.equal(canvas.data.cards.length, 3);
  assert.equal(canvas.data.wires.length, 1);
  assert.ok(canvas.data.pacing.flags.some((f) => f.code === 'orphan_promise'));
  assert.ok(canvas.data.pacing.flags.some((f) => f.code === 'long_talk_no_visual' || f.code === 'slow_beat' || f.code === 'runtime_mismatch'));

  const md = await fetch(`${ctx.url}/api/export/${id}/markdown`);
  assert.equal(md.status, 200);
  const mdText = await md.text();
  assert.match(mdText, /# Test video/);
  assert.match(mdText, /Shot list/);

  const json = await req(ctx.url, 'GET', `/api/export/${id}/json`);
  assert.equal(json.status, 200);
  assert.equal(json.data.board.title, 'Test video');

  const imported = await req(ctx.url, 'POST', '/api/export/import', json.data);
  assert.equal(imported.status, 201);
  assert.notEqual(imported.data.board.id, id);

  const listed = await req(ctx.url, 'GET', '/api/boards');
  assert.ok(listed.data.boards.length >= 2);

  const deleted = await req(ctx.url, 'DELETE', `/api/boards/${id}`);
  assert.equal(deleted.status, 200);
});

test('settings round-trip masks token', async (t) => {
  const ctx = await listen(app);
  t.after(() => ctx.close());
  const saved = await req(ctx.url, 'PUT', '/api/settings', {
    notion: { token: 'secret_test_token_abc', databaseId: 'db-1', mapping: { title: 'Video' } },
    hours: { defaultCapHours: 25, activityWatch: { enabled: false } },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.notion.tokenSet, true);
  assert.equal(saved.data.notion.token.includes('secret_test_token_abc'), false);
  assert.equal(saved.data.hours.defaultCapHours, 25);

  const got = await req(ctx.url, 'GET', '/api/settings');
  assert.equal(got.data.notion.databaseId, 'db-1');
  assert.equal(got.data.notion.mapping.title, 'Video');
});

test('files browse + hours manual entries', async (t) => {
  const ctx = await listen(app);
  t.after(() => ctx.close());
  const browse = await req(ctx.url, 'GET', `/api/files/browse?path=${encodeURIComponent(tmp)}`);
  assert.equal(browse.status, 200);
  assert.equal(browse.data.path, path.resolve(tmp));

  const board = await req(ctx.url, 'POST', '/api/boards', { title: 'Hours board', hoursCap: 10 });
  const id = board.data.board.id;
  const entry = await req(ctx.url, 'POST', `/api/hours/${id}/entries`, { hours: 2.5, note: 'edit day' });
  assert.equal(entry.status, 201);
  const summary = await req(ctx.url, 'GET', `/api/hours/${id}`);
  assert.equal(summary.status, 200);
  assert.ok(summary.data.spentHours >= 2.5);
  assert.equal(summary.data.capHours, 10);
});
