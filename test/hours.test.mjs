import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchActivityWatchHours, summarizeBoardHours } from '../src/services/hours.js';

test('summarizeBoardHours combines manual + AW and flags over budget', () => {
  const s = summarizeBoardHours({ cap: 30, manualHours: 10, awHours: 25, awOk: true });
  assert.equal(s.spentHours, 35);
  assert.equal(s.overBudget, true);
  assert.equal(s.remainingHours, 0);

  const degraded = summarizeBoardHours({
    cap: 30,
    manualHours: 4,
    awHours: 99,
    awOk: false,
    awReason: 'unreachable',
  });
  assert.equal(degraded.spentHours, 4);
  assert.equal(degraded.activityWatchHours, null);
  assert.equal(degraded.activityWatchReason, 'unreachable');
});

test('fetchActivityWatchHours sums matching window events via mocked API', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/api/0/buckets')) {
      return {
        ok: true,
        json: async () => ({
          'aw-watcher-window_host': { type: 'currentwindow' },
          'aw-watcher-afk_host': { type: 'afkstatus' },
        }),
      };
    }
    if (url.includes('/events')) {
      return {
        ok: true,
        json: async () => ([
          { duration: 3600, data: { app: 'resolve', title: 'My Cool Video — DaVinci Resolve' }, timestamp: '2026-11-01T10:00:00Z' },
          { duration: 1800, data: { app: 'obs', title: 'OBS Studio' }, timestamp: '2026-11-01T12:00:00Z' },
          { duration: 9999, data: { app: 'firefox', title: 'YouTube' }, timestamp: '2026-11-01T13:00:00Z' },
        ]),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };

  const res = await fetchActivityWatchHours({
    baseUrl: 'http://localhost:5600',
    apps: ['resolve', 'obs'],
    titleKeyword: '',
    startDate: '2026-10-01',
    fetchImpl,
  });
  assert.equal(res.ok, true);
  assert.equal(res.hours, 1.5);
  assert.equal(res.eventCount, 2);

  const filtered = await fetchActivityWatchHours({
    baseUrl: 'http://localhost:5600',
    apps: ['resolve', 'obs'],
    titleKeyword: 'Cool Video',
    startDate: '2026-10-01',
    fetchImpl,
  });
  assert.equal(filtered.hours, 1);
});

test('fetchActivityWatchHours degrades when unreachable', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const res = await fetchActivityWatchHours({ fetchImpl, apps: ['obs'] });
  assert.equal(res.ok, false);
  assert.match(res.reason, /ECONNREFUSED|unreachable/i);
  assert.equal(res.hours, 0);
});
