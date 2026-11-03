import { loadSettings } from '../config.js';

/**
 * Query ActivityWatch window buckets (read-only) and sum time for matching apps.
 * Never writes to ActivityWatch. Degrades gracefully when unreachable.
 */
export async function fetchActivityWatchHours({
  baseUrl,
  apps = [],
  titleKeyword = '',
  startDate = null,
  endDate = null,
  fetchImpl = fetch,
} = {}) {
  const settings = loadSettings();
  const url = (baseUrl || settings.hours?.activityWatch?.baseUrl || 'http://localhost:5600').replace(/\/$/, '');
  const appList = (apps?.length ? apps : settings.hours?.activityWatch?.apps || []).map((a) => String(a).toLowerCase());
  const start = startDate ? new Date(startDate) : new Date(Date.now() - 1000 * 60 * 60 * 24 * 90);
  const end = endDate ? new Date(endDate) : new Date();

  try {
    const bucketsRes = await fetchImpl(`${url}/api/0/buckets`, { signal: AbortSignal.timeout(3000) });
    if (!bucketsRes.ok) {
      return { ok: false, reason: `ActivityWatch HTTP ${bucketsRes.status}`, hours: 0, events: [] };
    }
    const buckets = await bucketsRes.json();
    const windowBuckets = Object.entries(buckets || {})
      .filter(([id, b]) => {
        const type = b?.type || '';
        return type.includes('window') || id.includes('window');
      })
      .map(([id]) => id);

    if (!windowBuckets.length) {
      return { ok: true, hours: 0, buckets: [], events: [], note: 'No window watcher buckets found' };
    }

    let totalSec = 0;
    const matched = [];
    const startIso = start.toISOString();
    const endIso = end.toISOString();

    for (const bucketId of windowBuckets) {
      const q = new URLSearchParams({ start: startIso, end: endIso });
      const evRes = await fetchImpl(`${url}/api/0/buckets/${encodeURIComponent(bucketId)}/events?${q}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!evRes.ok) continue;
      const events = await evRes.json();
      for (const ev of events || []) {
        const data = ev.data || {};
        const app = String(data.app || data.application || '');
        const title = String(data.title || '');
        const hay = `${app} ${title}`.toLowerCase();
        const appHit = !appList.length || appList.some((a) => hay.includes(a));
        const titleHit = !titleKeyword || title.toLowerCase().includes(String(titleKeyword).toLowerCase());
        if (!appHit || !titleHit) continue;
        const dur = Number(ev.duration || 0);
        totalSec += dur;
        matched.push({
          bucketId,
          app,
          title,
          durationSec: dur,
          timestamp: ev.timestamp,
        });
      }
    }

    return {
      ok: true,
      hours: totalSec / 3600,
      seconds: totalSec,
      buckets: windowBuckets,
      events: matched.slice(0, 200),
      eventCount: matched.length,
      range: { start: startIso, end: endIso },
    };
  } catch (err) {
    return {
      ok: false,
      reason: err?.name === 'TimeoutError' ? 'ActivityWatch unreachable (timeout)' : (err.message || 'unreachable'),
      hours: 0,
      events: [],
    };
  }
}

export function summarizeBoardHours({ cap, manualHours = 0, awHours = 0, awOk = false, awReason = '' }) {
  const spent = Number(manualHours || 0) + (awOk ? Number(awHours || 0) : 0);
  const limit = cap == null ? null : Number(cap);
  return {
    capHours: limit,
    manualHours: Number(manualHours || 0),
    activityWatchHours: awOk ? Number(awHours || 0) : null,
    activityWatchOk: awOk,
    activityWatchReason: awOk ? null : awReason || null,
    spentHours: spent,
    remainingHours: limit == null ? null : Math.max(0, limit - spent),
    overBudget: limit != null && spent > limit,
  };
}
