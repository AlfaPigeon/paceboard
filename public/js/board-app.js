import { api } from '/js/api.js';

const params = new URLSearchParams(location.search);
const boardId = params.get('id');
if (!boardId) location.href = '/';

const state = {
  board: null,
  cards: [],
  wires: [],
  groups: [],
  beats: [],
  pacing: null,
  pan: { x: 40, y: 40 },
  scale: 1,
  selectedId: null,
  wireMode: false,
  wireFrom: null,
  dirty: false,
  saving: false,
};

const world = document.getElementById('world');
const wrap = document.getElementById('canvas-wrap');
const wiresSvg = document.getElementById('wires');
const saveDot = document.getElementById('save-dot');
const saveState = document.getElementById('save-state');

function uid(prefix) {
  return `${prefix}_${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16).slice(-4)}`;
}

async function load() {
  const data = await api(`/api/boards/${boardId}`);
  state.board = data.board;
  state.cards = data.cards;
  state.wires = data.wires;
  state.groups = data.groups;
  state.beats = data.beats;
  state.pacing = data.pacing;
  syncForm();
  render();
  refreshHours();
}

function syncForm() {
  document.getElementById('board-title').value = state.board.title;
  document.getElementById('board-status').textContent = state.board.status;
  document.getElementById('aud-who').value = state.board.audience?.who || '';
  document.getElementById('aud-know').value = state.board.audience?.alreadyKnow || '';
  document.getElementById('aud-promise').value = state.board.audience?.promise || '';
  document.getElementById('aud-persona').value = state.board.audience?.persona || '';
  document.getElementById('hours-cap').value = state.board.hoursCap ?? 30;
  document.getElementById('hours-filter').value = state.board.hoursAwFilter || '';
  document.getElementById('hours-start').value = (state.board.hoursAwStart || '').slice(0, 10);
  document.getElementById('target-runtime').value = state.board.targetRuntimeSec || 600;
}

function markDirty() {
  state.dirty = true;
  saveDot.classList.add('busy');
  saveState.lastChild.textContent = ' Unsaved';
  scheduleSave();
}

let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 450);
}

async function save() {
  if (!state.dirty || state.saving) return;
  state.saving = true;
  try {
    readAudienceIntoState();
    const body = {
      board: {
        title: document.getElementById('board-title').value,
        status: state.board.status,
        targetRuntimeSec: Number(document.getElementById('target-runtime').value || 600),
        audience: state.board.audience,
      },
      cards: state.cards,
      wires: state.wires,
      groups: state.groups,
      beats: state.beats,
    };
    const data = await api(`/api/boards/${boardId}/canvas`, { method: 'PUT', body });
    state.board = data.board;
    state.cards = data.cards;
    state.wires = data.wires;
    state.groups = data.groups;
    state.beats = data.beats;
    state.pacing = data.pacing;
    state.dirty = false;
    saveDot.classList.remove('busy');
    saveState.lastChild.textContent = ' Saved';
    renderTimeline();
    renderOrphans();
  } catch (e) {
    saveDot.classList.add('err');
    saveState.lastChild.textContent = ` Save failed: ${e.message}`;
  } finally {
    state.saving = false;
    if (state.dirty) scheduleSave();
  }
}

function readAudienceIntoState() {
  state.board.audience = {
    who: document.getElementById('aud-who').value,
    alreadyKnow: document.getElementById('aud-know').value,
    promise: document.getElementById('aud-promise').value,
    persona: document.getElementById('aud-persona').value,
  };
}

function render() {
  world.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.scale})`;
  world.innerHTML = '';
  for (const g of state.groups) {
    const el = document.createElement('div');
    el.className = 'group-box';
    el.style.left = `${g.x}px`;
    el.style.top = `${g.y}px`;
    el.style.width = `${g.w}px`;
    el.style.height = `${g.h}px`;
    el.innerHTML = `<div class="card-title" contenteditable="true"></div>`;
    el.querySelector('.card-title').textContent = g.title;
    el.querySelector('.card-title').oninput = (e) => { g.title = e.target.textContent; markDirty(); };
    enableDrag(el, g, true);
    world.appendChild(el);
  }
  for (const c of state.cards) {
    const el = document.createElement('div');
    el.className = 'card' + (state.selectedId === c.id ? ' selected' : '');
    el.dataset.type = c.type;
    el.dataset.id = c.id;
    el.style.left = `${c.x}px`;
    el.style.top = `${c.y}px`;
    el.style.width = `${c.w}px`;
    el.style.minHeight = `${c.h}px`;
    el.innerHTML = `
      <div class="card-type"></div>
      <div class="card-title" contenteditable="true"></div>
      <div class="card-body" contenteditable="true"></div>
    `;
    el.querySelector('.card-type').textContent = c.type;
    el.querySelector('.card-title').textContent = c.title;
    el.querySelector('.card-body').textContent = c.body;
    el.querySelector('.card-title').oninput = (e) => { c.title = e.target.textContent; markDirty(); };
    el.querySelector('.card-body').oninput = (e) => { c.body = e.target.innerText; markDirty(); };
    el.onpointerdown = (e) => {
      if (e.target.isContentEditable) return;
      selectCard(c.id);
      if (state.wireMode) {
        e.stopPropagation();
        if (!state.wireFrom) state.wireFrom = c.id;
        else if (state.wireFrom !== c.id) {
          state.wires.push({ id: uid('wire'), fromCardId: state.wireFrom, toCardId: c.id, kind: 'flow', data: {} });
          state.wireFrom = null;
          markDirty();
          render();
        }
        return;
      }
    };
    enableDrag(el, c, false);
    world.appendChild(el);
  }
  drawWires();
  renderTimeline();
  renderOrphans();
  renderSelection();
}

function drawWires() {
  const cardMap = Object.fromEntries(state.cards.map((c) => [c.id, c]));
  let paths = '';
  for (const w of state.wires) {
    const a = cardMap[w.fromCardId];
    const b = cardMap[w.toCardId];
    if (!a || !b) continue;
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const cx = (x1 + x2) / 2;
    paths += `<path d="M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}" />`;
  }
  wiresSvg.innerHTML = paths;
  wiresSvg.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.scale})`;
  wiresSvg.style.transformOrigin = '0 0';
  wiresSvg.setAttribute('width', '4000');
  wiresSvg.setAttribute('height', '4000');
}

function enableDrag(el, model, isGroup) {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.isContentEditable || state.wireMode) return;
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = model.x;
    const origY = model.y;
    const move = (ev) => {
      const dx = (ev.clientX - startX) / state.scale;
      const dy = (ev.clientY - startY) / state.scale;
      model.x = origX + dx;
      model.y = origY + dy;
      el.style.left = `${model.x}px`;
      el.style.top = `${model.y}px`;
      if (!isGroup) drawWires();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      markDirty();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

function selectCard(id) {
  state.selectedId = id;
  render();
}

function renderSelection() {
  const panel = document.getElementById('selection-panel');
  const c = state.cards.find((x) => x.id === state.selectedId);
  if (!c) {
    panel.innerHTML = '<span class="dim">Select a card</span>';
    return;
  }
  panel.innerHTML = `
    <div class="field"><label>Type</label><div>${c.type}</div></div>
    <div class="field"><label>Serves promise</label>
      <select id="sel-promise">
        <option value="1">Yes</option>
        <option value="0">No</option>
      </select>
    </div>
    <button id="sel-to-timeline">Add to timeline</button>
    <button id="sel-delete" class="ghost">Delete card</button>
  `;
  const beat = state.beats.find((b) => b.cardId === c.id);
  document.getElementById('sel-promise').value = beat && beat.servesPromise === false ? '0' : '1';
  document.getElementById('sel-promise').onchange = (e) => {
    if (beat) {
      beat.servesPromise = e.target.value !== '0';
      markDirty();
      renderTimeline();
      renderOrphans();
    } else {
      c.data = { ...c.data, servesPromise: e.target.value !== '0' };
      markDirty();
    }
  };
  document.getElementById('sel-to-timeline').onclick = () => addBeatFromCard(c);
  document.getElementById('sel-delete').onclick = () => {
    state.cards = state.cards.filter((x) => x.id !== c.id);
    state.wires = state.wires.filter((w) => w.fromCardId !== c.id && w.toCardId !== c.id);
    state.selectedId = null;
    markDirty();
    render();
  };
}

function addBeatFromCard(c) {
  const planned = c.data?.inSec != null && c.data?.outSec != null
    ? Math.max(1, c.data.outSec - c.data.inSec)
    : 30;
  state.beats.push({
    id: uid('beat'),
    cardId: c.id,
    ord: state.beats.length,
    label: c.title || c.type,
    plannedSec: planned,
    clipInSec: c.data?.inSec ?? null,
    clipOutSec: c.data?.outSec ?? null,
    servesPromise: c.data?.servesPromise !== false,
    data: { kind: c.type === 'note' ? 'talking' : 'visual' },
  });
  markDirty();
  renderTimeline();
}

function renderTimeline() {
  const lane = document.getElementById('timeline-lane');
  lane.innerHTML = '';
  const beats = [...state.beats].sort((a, b) => a.ord - b.ord);
  for (const b of beats) {
    const chip = document.createElement('div');
    chip.className = 'beat-chip';
    chip.innerHTML = `<strong></strong><div class="dim" style="font-size:12px"></div>`;
    chip.querySelector('strong').textContent = b.label || 'Beat';
    chip.querySelector('.dim').textContent = `${Math.round(b.plannedSec)}s`;
    chip.onclick = () => {
      const next = prompt('Planned seconds', String(b.plannedSec));
      if (next == null) return;
      b.plannedSec = Number(next) || b.plannedSec;
      markDirty();
      renderTimeline();
    };
    chip.oncontextmenu = (e) => {
      e.preventDefault();
      b.servesPromise = !b.servesPromise;
      markDirty();
      renderTimeline();
      renderOrphans();
    };
    lane.appendChild(chip);
  }

  const pacing = state.pacing;
  const total = beats.reduce((s, b) => s + Number(b.plannedSec || 0), 0);
  const target = Number(document.getElementById('target-runtime').value || state.board?.targetRuntimeSec || 600);
  const pct = target ? Math.min(100, (total / target) * 100) : 0;
  document.getElementById('pace-fill').style.width = `${pct}%`;
  document.getElementById('pace-label').textContent = `Planned ${fmt(total)} / target ${fmt(target)}`;

  const flagsEl = document.getElementById('timeline-flags');
  flagsEl.innerHTML = '';
  const flags = pacing?.flags || [];
  // local quick orphan check before save returns
  for (const f of flags) {
    const d = document.createElement('div');
    d.className = `flag ${f.severity || 'info'}`;
    d.textContent = f.message;
    flagsEl.appendChild(d);
  }
  if (!flags.length) {
    flagsEl.innerHTML = '<div class="dim">No pacing flags</div>';
  }
}

function renderOrphans() {
  const orphans = state.beats.filter((b) => b.servesPromise === false);
  document.getElementById('orphan-beats').textContent = orphans.length
    ? `${orphans.length} beat(s) do not serve the promise (right-click a beat to toggle).`
    : 'All timeline beats map to the promise.';
}

function fmt(sec) {
  const s = Math.round(Number(sec) || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Pan
let panning = false;
let panOrigin = null;
wrap.addEventListener('pointerdown', (e) => {
  if (e.button === 1 || e.button === 0 && (e.spaceKey || e.target === wrap || e.target === world || e.target === wiresSvg)) {
    if (e.target.closest?.('.card,.group-box')) return;
    panning = true;
    wrap.classList.add('panning');
    panOrigin = { x: e.clientX, y: e.clientY, px: state.pan.x, py: state.pan.y };
  }
});
window.addEventListener('pointermove', (e) => {
  if (!panning) return;
  state.pan.x = panOrigin.px + (e.clientX - panOrigin.x);
  state.pan.y = panOrigin.py + (e.clientY - panOrigin.y);
  world.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.scale})`;
  drawWires();
});
window.addEventListener('pointerup', () => {
  panning = false;
  wrap.classList.remove('panning');
});
wrap.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  state.scale = Math.min(2.5, Math.max(0.35, state.scale * delta));
  world.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.scale})`;
  drawWires();
}, { passive: false });

// Add tools
document.querySelectorAll('[data-add]').forEach((btn) => {
  btn.onclick = () => {
    const type = btn.dataset.add;
    const card = {
      id: uid('card'),
      type,
      title: type === 'beat' ? 'Beat' : type[0].toUpperCase() + type.slice(1),
      body: '',
      x: 120 - state.pan.x / state.scale,
      y: 120 - state.pan.y / state.scale,
      w: type === 'audience' ? 280 : 240,
      h: type === 'audience' ? 200 : 140,
      z: 1,
      data: {},
    };
    state.cards.push(card);
    state.selectedId = card.id;
    markDirty();
    render();
  };
});
document.getElementById('btn-add-group').onclick = () => {
  state.groups.push({
    id: uid('group'),
    title: 'Section',
    x: 80 - state.pan.x / state.scale,
    y: 80 - state.pan.y / state.scale,
    w: 520,
    h: 340,
    color: '#334155',
    data: {},
  });
  markDirty();
  render();
};
document.getElementById('btn-wire-mode').onclick = (e) => {
  state.wireMode = !state.wireMode;
  state.wireFrom = null;
  e.currentTarget.style.outline = state.wireMode ? '2px solid var(--accent)' : '';
};
document.getElementById('btn-add-beat').onclick = () => {
  state.beats.push({
    id: uid('beat'),
    cardId: null,
    ord: state.beats.length,
    label: `Beat ${state.beats.length + 1}`,
    plannedSec: 30,
    servesPromise: true,
    data: {},
  });
  markDirty();
  renderTimeline();
};

['aud-who','aud-know','aud-promise','aud-persona','board-title','target-runtime','hours-cap','hours-filter','hours-start']
  .forEach((id) => {
    document.getElementById(id).addEventListener('change', async () => {
      if (id.startsWith('hours')) {
        await api(`/api/boards/${boardId}`, {
          method: 'PATCH',
          body: {
            hoursCap: Number(document.getElementById('hours-cap').value),
            hoursAwFilter: document.getElementById('hours-filter').value || null,
            hoursAwStart: document.getElementById('hours-start').value || null,
          },
        });
        refreshHours();
        return;
      }
      if (id === 'target-runtime') state.board.targetRuntimeSec = Number(document.getElementById('target-runtime').value);
      markDirty();
    });
    document.getElementById(id).addEventListener('input', () => {
      if (!id.startsWith('hours')) markDirty();
    });
  });

async function refreshHours() {
  try {
    const h = await api(`/api/hours/${boardId}`);
    const el = document.getElementById('hours-summary');
    const aw = h.activityWatchOk
      ? `AW ${h.activityWatchHours.toFixed(2)}h`
      : `AW off/unavailable${h.activityWatchReason ? ` (${h.activityWatchReason})` : ''}`;
    el.innerHTML = `
      <div><strong>${h.spentHours.toFixed(2)}h</strong> spent / ${h.capHours ?? '∞'}h cap ${h.overBudget ? '⚠ over' : ''}</div>
      <div class="dim">Manual ${h.manualHours.toFixed(2)}h · ${aw}</div>
    `;
  } catch (e) {
    document.getElementById('hours-summary').textContent = e.message;
  }
}
document.getElementById('btn-refresh-hours').onclick = refreshHours;
document.getElementById('btn-add-hours').onclick = async () => {
  const hours = Number(document.getElementById('hours-manual').value);
  if (!hours) return;
  await api(`/api/hours/${boardId}/entries`, { method: 'POST', body: { hours, note: 'manual' } });
  document.getElementById('hours-manual').value = '';
  refreshHours();
};

document.getElementById('btn-export-md').onclick = () => {
  window.open(`/api/export/${boardId}/markdown`, '_blank');
};
document.getElementById('btn-export-json').onclick = () => {
  window.open(`/api/export/${boardId}/json`, '_blank');
};
document.getElementById('btn-push-notion').onclick = async () => {
  try {
    await save();
    const res = await api(`/api/notion/boards/${boardId}/push`, { method: 'POST', body: {} });
    alert(res.ok ? 'Pushed to Notion' : JSON.stringify(res));
  } catch (e) {
    if (e.status === 409) {
      if (confirm('Conflict with Notion. Force push local values?')) {
        await api(`/api/notion/boards/${boardId}/push`, { method: 'POST', body: { force: true } });
        alert('Force-pushed');
      }
    } else alert(e.message);
  }
};

// Media browser
const mediaModal = document.getElementById('media-modal');
document.getElementById('btn-media').onclick = async () => {
  mediaModal.classList.add('open');
  await browse('');
};
document.getElementById('media-close').onclick = () => mediaModal.classList.remove('open');
document.getElementById('browse-go').onclick = () => browse(document.getElementById('browse-path').value);
document.getElementById('browse-up').onclick = async () => {
  const cur = document.getElementById('browse-path').value;
  const parent = cur.replace(/\/[^/]+\/?$/, '') || '/';
  browse(parent || '/');
};
document.getElementById('file-upload').onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  fd.append('boardId', boardId);
  const res = await fetch('/api/media/upload', { method: 'POST', body: fd });
  const data = await res.json();
  pollMediaJob(data);
};

async function browse(path) {
  const q = path ? `?path=${encodeURIComponent(path)}` : '';
  const data = await api(`/api/files/browse${q}`);
  document.getElementById('browse-path').value = data.path;
  const list = document.getElementById('file-list');
  list.innerHTML = '';
  for (const ent of data.entries) {
    const btn = document.createElement('button');
    btn.innerHTML = `<span>${ent.isDir ? '📁' : ent.isVideo ? '🎬' : '📄'} ${ent.name}</span><span class="dim">${ent.isVideo ? 'import' : ''}</span>`;
    btn.onclick = async () => {
      if (ent.isDir) return browse(ent.path);
      if (!ent.isVideo) return;
      const result = await api('/api/media/import-path', { method: 'POST', body: { path: ent.path, boardId } });
      pollMediaJob(result);
    };
    list.appendChild(btn);
  }
}

async function pollMediaJob(result) {
  const out = document.getElementById('media-job');
  if (result.cached) {
    out.textContent = `Cached proxy ready: ${result.media.id}`;
    await spawnClipCards(result.media.id);
    return;
  }
  const jobId = result.job?.id;
  if (!jobId) return;
  out.textContent = `Job ${jobId}…`;
  const timer = setInterval(async () => {
    const job = await api(`/api/jobs/${jobId}`);
    out.textContent = `${job.status} ${(job.progress * 100).toFixed(0)}% ${job.error || ''}`;
    if (job.status === 'done') {
      clearInterval(timer);
      await spawnClipCards(result.media.id);
    }
    if (job.status === 'error' || job.status === 'cancelled') clearInterval(timer);
  }, 800);
}

async function spawnClipCards(mediaId) {
  const { cards } = await api(`/api/media/${mediaId}/clip-cards`, {
    method: 'POST',
    body: { boardId, origin: { x: 200, y: 200 } },
  });
  // reload board to pick up cards
  await load();
  document.getElementById('media-job').textContent = `Added ${cards.length} scene clip cards`;
}

load().catch((e) => alert(e.message));
window.addEventListener('beforeunload', (e) => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
});
