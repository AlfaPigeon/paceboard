/** Explainable pacing rules for a board timeline. */

export function analyzePacing({ beats = [], targetRuntimeSec = 600, hookWindowSec = 15 } = {}) {
  const ordered = [...beats].sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
  const totalPlanned = ordered.reduce((s, b) => s + Number(b.plannedSec || 0), 0);
  const avg = ordered.length ? totalPlanned / ordered.length : 0;
  const flags = [];
  const curve = [];
  const parts = [];
  let t = 0;
  let cumTarget = 0;
  let slowCount = 0;

  for (const beat of ordered) {
    const dur = Number(beat.plannedSec || 0);
    const targetSec = Number(beat.data?.targetSec ?? beat.targetSec ?? 0) || null;
    const start = t;
    const end = t + dur;
    const overBy = targetSec != null && dur > targetSec ? dur - targetSec : 0;
    if (overBy > 0) slowCount += 1;

    curve.push({
      id: beat.id,
      label: beat.label,
      start,
      end,
      duration: dur,
      targetSec,
      overBy,
      cumPlanned: end,
      ratioToAvg: avg ? dur / avg : 1,
      slow: overBy > 0,
    });

    parts.push({
      id: beat.id,
      label: beat.label,
      plannedSec: dur,
      targetSec,
      overBy,
      slow: overBy > 0,
      servesPromise: beat.servesPromise !== false,
      fit: beat.data?.fit || (beat.servesPromise === false ? 'weak' : 'ok'),
    });

    if (targetSec != null && overBy > 0) {
      flags.push({
        code: 'over_part_target',
        severity: 'warn',
        beatId: beat.id,
        message: `"${beat.label || 'Beat'}" is ${fmt(dur)} vs part target ${fmt(targetSec)} (+${fmt(overBy)}).`,
      });
    }

    if (avg && dur > avg * 1.8 && !(targetSec != null)) {
      flags.push({
        code: 'slow_beat',
        severity: 'warn',
        beatId: beat.id,
        message: `"${beat.label || 'Beat'}" is ${dur.toFixed(0)}s (${(dur / avg).toFixed(1)}× average). Consider splitting.`,
      });
    }

    if (!beat.servesPromise) {
      flags.push({
        code: 'orphan_promise',
        severity: 'warn',
        beatId: beat.id,
        message: `"${beat.label || 'Beat'}" does not serve the audience promise.`,
      });
    }

    const noVisual = beat.data?.kind === 'talking' || beat.data?.visualChange === false;
    if (noVisual && dur >= Math.max(45, avg * 1.5 || 45)) {
      flags.push({
        code: 'long_talk_no_visual',
        severity: 'warn',
        beatId: beat.id,
        message: `"${beat.label || 'Beat'}" is a long talking segment without a marked visual change.`,
      });
    }

    if (avg && dur > 0 && dur < avg * 0.35 && dur < 8) {
      flags.push({
        code: 'rushed_beat',
        severity: 'info',
        beatId: beat.id,
        message: `"${beat.label || 'Beat'}" is only ${dur.toFixed(0)}s — may feel rushed.`,
      });
    }

    if (targetSec != null) cumTarget += targetSec;
    t = end;
  }

  if (ordered.length) {
    const first = ordered[0];
    const firstDur = Number(first.plannedSec || 0);
    if (firstDur > hookWindowSec * 1.5) {
      flags.push({
        code: 'late_hook',
        severity: 'warn',
        beatId: first.id,
        message: `Hook/opening beat is ${firstDur.toFixed(0)}s; aim to land the promise within ~${hookWindowSec}s.`,
      });
    }
  } else {
    flags.push({
      code: 'empty_timeline',
      severity: 'info',
      message: 'Timeline has no beats yet.',
    });
  }

  const runtimeDelta = totalPlanned - Number(targetRuntimeSec || 0);
  if (Math.abs(runtimeDelta) > Math.max(20, (targetRuntimeSec || 0) * 0.12)) {
    flags.push({
      code: 'runtime_mismatch',
      severity: runtimeDelta > 0 ? 'warn' : 'info',
      message: `Planned ${fmt(totalPlanned)} vs target ${fmt(targetRuntimeSec)} (${runtimeDelta > 0 ? '+' : ''}${fmt(runtimeDelta)}).`,
    });
  }

  return {
    totalPlannedSec: totalPlanned,
    targetRuntimeSec: Number(targetRuntimeSec || 0),
    headroomSec: Number(targetRuntimeSec || 0) - totalPlanned,
    averageBeatSec: avg,
    slowStretches: slowCount,
    curve,
    parts,
    flags,
  };
}

export function fmt(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

export function fmtSigned(sec) {
  const n = Math.round(Number(sec) || 0);
  const sign = n > 0 ? '+' : n < 0 ? '−' : '';
  return `${sign}${fmt(Math.abs(n))}`;
}
