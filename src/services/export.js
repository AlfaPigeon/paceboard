export function boardToMarkdown({ board, cards = [], beats = [], wires = [] }) {
  const audience = board.audience || {};
  const lines = [];
  lines.push(`# ${board.title}`);
  lines.push('');
  lines.push(`Status: **${board.status}**`);
  if (board.targetRuntimeSec) lines.push(`Target runtime: **${fmt(board.targetRuntimeSec)}**`);
  lines.push('');
  lines.push('## Audience');
  lines.push(`- Who: ${audience.who || '—'}`);
  lines.push(`- Already know: ${audience.alreadyKnow || '—'}`);
  lines.push(`- Promise / hook: ${audience.promise || '—'}`);
  lines.push(`- Persona: ${audience.persona || '—'}`);
  lines.push('');
  lines.push('## Script outline');
  const ordered = [...beats].sort((a, b) => a.ord - b.ord);
  if (!ordered.length) lines.push('_No beats yet._');
  ordered.forEach((b, i) => {
    lines.push(`### ${i + 1}. ${b.label || 'Beat'} (${fmt(b.plannedSec)})`);
    const card = cards.find((c) => c.id === b.cardId);
    if (card?.body) lines.push(card.body.trim());
    else if (b.data?.notes) lines.push(String(b.data.notes));
    else lines.push('_Notes TBD_');
    if (!b.servesPromise) lines.push('> ⚠ Does not map to audience promise');
    lines.push('');
  });
  lines.push('## Shot list');
  lines.push('| # | Beat | In | Out | Duration | Notes |');
  lines.push('|---|------|----|-----|----------|-------|');
  ordered.forEach((b, i) => {
    const inn = b.clipInSec != null ? fmt(b.clipInSec) : '—';
    const out = b.clipOutSec != null ? fmt(b.clipOutSec) : '—';
    const notes = (b.data?.shot || cardTitle(cards, b.cardId) || '').replace(/\|/g, '/');
    lines.push(`| ${i + 1} | ${(b.label || '').replace(/\|/g, '/')} | ${inn} | ${out} | ${fmt(b.plannedSec)} | ${notes} |`);
  });
  lines.push('');
  lines.push('## Canvas cards');
  for (const c of cards) {
    lines.push(`- **[${c.type}] ${c.title || '(untitled)'}**: ${(c.body || '').slice(0, 200)}`);
  }
  if (wires.length) {
    lines.push('');
    lines.push(`_Wires: ${wires.length}_`);
  }
  return lines.join('\n');
}

export function boardToJsonBundle({ board, cards, wires, groups, beats }) {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    board,
    cards,
    wires,
    groups,
    beats,
  };
}

function cardTitle(cards, id) {
  return cards.find((c) => c.id === id)?.title || '';
}

function fmt(sec) {
  const s = Math.round(Number(sec) || 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
