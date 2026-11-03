import { APP_NAME } from './brand.js';
import { api } from './api.js';

document.title = APP_NAME;
document.getElementById('brand-name').textContent = APP_NAME;

const state = {
  route: { name: 'boards' },
  boards: [],
  settings: null,
  board: null,
  pacing: null,
  hours: null,
  media: [],
  pipeline: [],
  conflict: null,
  selectedBeatId: null,
  zoom: 1,
  pan: { x: 0, y: 0 },
  saveTimer: null,
  demo: false,
};

const MARK_SVG = `<svg width="14" height="14" viewBox="0 0 14 14"><path d="M2 3h2v8H2zm4 0h2v8H6zm4 0h2v8h-2z" fill="currentColor"/></svg>`;

function $(sel, el = document) { return el.querySelector(sel); }
function $$(sel, el = document) { return [...el.querySelectorAll(sel)]; }

function fmt(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
function fmtSigned(sec) {
  const n = Math.round(Number(sec) || 0);
  if (!n) return '0:00';
  return `${n > 0 ? '+' : '−'}${fmt(Math.abs(n))}`;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
function stagePill(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'publish' || s === 'published') return `<span class="pill pill-publish">Publish</span>`;
  if (s === 'draft') return `<span class="pill pill-draft">Draft</span>`;
  if (!s || s === 'idea' || s === 'unstaged') return `<span class="pill pill-unstaged">unstaged</span>`;
  return `<span class="pill">${escapeHtml(status)}</span>`;
}
function istanbul(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit',
      day: '2-digit', month: 'short',
    }) + ' Europe/Istanbul';
  } catch { return iso; }
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const params = new URLSearchParams(qs || '');
  state.demo = params.get('demo') === '1' || params.get('demo') === 'true';
  const parts = (path || 'boards').split('/').filter(Boolean);
  if (!parts.length) return { name: 'boards' };
  if (parts[0] === 'boards' && !parts[1]) return { name: 'boards' };
  if (parts[0] === 'board' && parts[1]) {
    if (parts[2] === 'pace') return { name: 'pace', boardId: parts[1] };
    return { name: 'board', boardId: parts[1] };
  }
  if (parts[0] === 'pipeline') return { name: 'pipeline' };
  if (parts[0] === 'library') return { name: 'library' };
  if (parts[0] === 'settings') {
    if (parts[1] === 'notion') return { name: 'notion' };
    if (parts[1] === 'hours') return { name: 'hours-settings' };
    return { name: 'settings' };
  }
  if (parts[0] === 'empty') return { name: 'boards', forceEmpty: true };
  return { name: 'boards' };
}

function navigate(hash) {
  if (!hash.startsWith('#')) hash = '#/' + hash.replace(/^\//, '');
  if (location.hash === hash) {
    state.route = parseHash();
    render();
  } else {
    location.hash = hash;
  }
}

function setNavActive(name) {
  $$('.nav-item').forEach((el) => {
    const key = el.dataset.nav;
    const active = (name === 'board' || name === 'pace' || name === 'boards') ? key === 'boards'
      : (name === 'notion' || name === 'hours-settings' || name === 'settings') ? key === 'settings'
      : key === name;
    el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
}

async function loadSettings() {
  state.settings = await api('/api/settings');
  return state.settings;
}

async function loadBoards() {
  const data = await api('/api/boards');
  state.boards = data.boards || [];
  return state.boards;
}

async function loadBoard(id) {
  const data = await api(`/api/boards/${id}`);
  state.board = data;
  state.pacing = data.pacing;
  state.selectedBeatId = data.beats?.[0]?.id || null;
  try { state.hours = await api(`/api/hours/${id}`); } catch { state.hours = null; }
  try {
    const m = await api(`/api/media?boardId=${encodeURIComponent(id)}`);
    state.media = m.media || [];
  } catch { state.media = []; }
  return data;
}

async function loadPipeline() {
  try {
    const data = await api('/api/notion/import', { method: 'POST', body: { createBoards: false } });
    state.pipeline = data.ideas || [];
    $('#pipeline-count').textContent = state.pipeline.length || '';
  } catch {
    state.pipeline = [];
    $('#pipeline-count').textContent = '';
  }
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveCanvas(), 500);
}

async function saveCanvas() {
  if (!state.board?.board?.id) return;
  const b = state.board;
  const payload = {
    cards: b.cards,
    wires: b.wires,
    groups: b.groups,
    beats: b.beats,
    board: {
      title: b.board.title,
      status: b.board.status,
      targetRuntimeSec: b.board.targetRuntimeSec,
      audience: b.board.audience,
    },
  };
  try {
    const data = await api(`/api/boards/${b.board.id}/canvas`, { method: 'PUT', body: payload });
    state.board = data;
    state.pacing = data.pacing;
  } catch (err) {
    console.error(err);
  }
}

function sheet() { return document.getElementById('sheet'); }

function render() {
  const route = state.route;
  setNavActive(route.name);
  const top = $('#top-right');
  if (state.demo) top.textContent = 'Demo · non-personal';
  else if (state.settings?.notion?.tokenSet) top.textContent = 'Notion linked';
  else top.textContent = 'Local';

  if (route.name === 'boards') return renderBoards();
  if (route.name === 'board') return renderBoard();
  if (route.name === 'pace') return renderPace();
  if (route.name === 'pipeline') return renderPipeline();
  if (route.name === 'library') return renderLibrary();
  if (route.name === 'notion') return renderNotion();
  if (route.name === 'hours-settings' || route.name === 'settings') return renderSettings();
  return renderBoards();
}

/* ---------- Boards / first-run ---------- */
function renderBoards() {
  const empty = state.route.forceEmpty || !state.boards.length;
  const el = sheet();
  el.className = 'sheet';
  if (empty) {
    el.innerHTML = `
      <div class="sheet-pad">
        <div class="title-row">
          <div>
            <h1>Boards</h1>
            <p class="sub">0 boards. Connect Notion or start a board from a local idea.</p>
          </div>
        </div>
        <div class="setup">
          <div class="step done">
            <div class="n">Done</div>
            <h2>Install ${escapeHtml(APP_NAME)}</h2>
            <p>Local web app on this Arch machine — same pattern as your other tools.</p>
          </div>
          <div class="step">
            <div class="n">Next</div>
            <h2>Connect Notion</h2>
            <p>Pick Video pipeline. Mapping will open pre-filled for stage, persona, leave-behind, link, target week.</p>
          </div>
          <div class="step">
            <div class="n">Then</div>
            <h2>Import a clip</h2>
            <p>MKV or ProRes/DNxHR MOV. ${escapeHtml(APP_NAME)} builds an H.264 proxy; your source file stays untouched.</p>
          </div>
        </div>
        <div class="empty-boards">
          <h2>No boards yet</h2>
          <p>Boards hold the canvas, beat timeline, audience card and pace curve for one video idea.</p>
          <div class="row">
            <button class="btn btn-primary" data-act="connect-notion">Connect Notion</button>
            <button class="btn btn-secondary" data-act="new-board">New board</button>
          </div>
        </div>
        ${hoursOffBar()}
      </div>`;
  } else {
    el.innerHTML = `
      <div class="sheet-pad">
        <div class="title-row">
          <div>
            <h1>Boards</h1>
            <p class="sub">${state.boards.length} board${state.boards.length === 1 ? '' : 's'} · one board per video idea</p>
          </div>
          <div class="actions">
            <button class="btn btn-secondary" data-act="connect-notion">Notion</button>
            <button class="btn btn-primary" data-act="new-board">New board</button>
          </div>
        </div>
        <div class="board-list">
          ${state.boards.map((b) => `
            <div class="board-row" data-open-board="${escapeHtml(b.id)}">
              <div>
                <div class="name">${escapeHtml(b.title)}</div>
                <div class="meta">${escapeHtml(b.meta?.targetWeek || '—')} · updated ${escapeHtml(istanbul(b.updatedAt))}</div>
              </div>
              <div>${stagePill(b.status)}</div>
              <div class="mono meta">${fmt(b.targetRuntimeSec)}</div>
              <div class="meta">${b.notionPageId ? 'Linked' : 'Local'}</div>
            </div>`).join('')}
        </div>
        ${hoursOffBar()}
      </div>`;
  }
  bindCommon();
}

function hoursOffBar() {
  const aw = state.settings?.hours?.activityWatch?.enabled;
  if (aw) {
    return `<div class="hours-off-bar"><span class="label">Hours</span><span>ActivityWatch enabled · default cap ${state.settings?.hours?.defaultCapHours ?? 30} h</span></div>`;
  }
  return `
    <div class="hours-off-bar">
      <span class="label">Hours off</span>
      <span>ActivityWatch not detected. Optional — track Resolve and OBS time against a cap.</span>
      <div class="actions">
        <button class="btn-link" data-act="log-hours-global">+ log hours</button>
        <button class="btn-link muted" data-act="hours-settings">Set up ActivityWatch</button>
      </div>
    </div>`;
}

/* ---------- Board canvas ---------- */
function renderBoard() {
  const b = state.board;
  if (!b) { sheet().innerHTML = `<div class="sheet-pad"><p>Loading…</p></div>`; return; }
  const board = b.board;
  const pacing = state.pacing || {};
  const hours = state.hours;
  const hoursLabel = hours && (hours.spentHours > 0 || hours.activityWatch?.ok)
    ? `${Number(hours.spentHours).toFixed(1)} of ${hours.capHours} h`
    : null;
  const el = sheet();
  el.className = 'sheet board-sheet';
  el.innerHTML = `
    <div class="board-bar">
      <button class="btn btn-ghost" data-act="back-boards" style="padding:0 6px">←</button>
      <input class="title-edit" id="board-title" value="${escapeHtml(board.title)}" />
      ${stagePill(board.status)}
      <span class="meta" id="board-week">${escapeHtml(board.meta?.targetWeek ? 'Week ' + board.meta.targetWeek : '')}</span>
      <div class="actions">
        <span class="meta mono">${fmt(pacing.totalPlannedSec)} / ${fmt(board.targetRuntimeSec)}</span>
        <button class="btn btn-secondary" data-act="open-pace">Pace</button>
        <button class="btn btn-secondary" data-act="sync-board">Sync</button>
        <button class="btn btn-primary" data-act="export-md">Export MD</button>
      </div>
    </div>
    <div class="workspace">
      <aside class="palette" id="clip-palette">${renderPalette()}</aside>
      <section class="canvas-panel" id="canvas-panel" aria-label="Board canvas">
        <div class="tool-rail">
          <button type="button" data-add="beat" title="Add beat">Beat</button>
          <button type="button" data-add="note" title="Add note">Note</button>
          <button type="button" data-add="audience" title="Audience">Aud</button>
        </div>
        <div class="canvas-world" id="canvas-world" style="transform:translate(${state.pan.x}px,${state.pan.y}px) scale(${state.zoom})">
          <svg class="wires" id="wires"></svg>
          ${b.cards.map(renderCard).join('')}
        </div>
        <div class="canvas-tools">
          <button type="button" data-zoom="-">−</button>
          <button type="button" data-zoom="reset">${Math.round(state.zoom * 100)}%</button>
          <button type="button" data-zoom="+">+</button>
        </div>
      </section>
    </div>
    <div class="timeline">
      <div class="tl-head">
        <h2>Timeline</h2>
        <span class="meta">Beats · drop clips here</span>
        <div class="runtime">Planned <strong>${fmt(pacing.totalPlannedSec)}</strong> · Target <strong>${fmt(board.targetRuntimeSec)}</strong></div>
      </div>
      <div class="beats-lane" id="beats-lane">${renderBeatLanes()}</div>
      <div class="tl-foot">
        <span>Pace</span>
        <div class="mini-curve" id="mini-curve">${renderMiniCurve()}</div>
        <span class="hours-meter ${hoursLabel ? '' : 'off'}" id="hours-meter">${hoursLabel || 'Hours off'}</span>
        <button class="btn-link" data-act="log-hours">${hoursLabel ? '+ log hours' : '+ log hours'}</button>
        <span class="faint">${hours?.activityWatch?.ok ? 'Resolve + OBS' : ''}</span>
      </div>
    </div>`;
  bindBoard();
  drawWires();
}

function renderPalette() {
  const media = state.media || [];
  const clips = media.map((m) => {
    const name = (m.sourcePath || '').split('/').pop() || m.id;
    const ready = m.status === 'ready';
    const building = m.status === 'processing' || m.status === 'queued';
    if (building) {
      const pct = Math.round((m.progress || 0) * 100);
      return `<div class="proxy-row"><strong>${escapeHtml(name)}</strong> · ProRes → H.264 proxy<br>
        Building ${pct}% · <button class="btn-link" data-cancel-job="${escapeHtml(m.jobId || m.id)}">Cancel</button>
        <div class="progress"><span style="width:${pct}%"></span></div></div>`;
    }
    const wave = (m.waveform || []).slice(0, 6);
    const bars = wave.length
      ? wave.map((v) => `<i style="height:${Math.max(20, Math.round((v || 0.3) * 100))}%"></i>`).join('')
      : `<i style="height:40%"></i><i style="height:70%"></i><i style="height:55%"></i><i style="height:90%"></i><i style="height:35%"></i><i style="height:60%"></i>`;
    return `<div class="clip" draggable="true" data-media="${escapeHtml(m.id)}">
      <div class="thumb"><div class="bar">${bars}</div></div>
      <div><div class="name">${escapeHtml(name)}</div>
      <div class="sub"><span class="mono">${fmt(m.durationSec)}</span>
      <span class="pill ${ready ? 'pill-proxy' : 'pill-warn'}">${ready ? 'Ready' : escapeHtml(m.status || '…')}</span></div></div></div>`;
  }).join('');
  return `
    <h2>Clips</h2>
    <p class="hint">Drop MKV or MOV. Proxies are H.264; sources are never touched.</p>
    ${clips || '<p class="hint">No clips yet.</p>'}
    <div class="dropzone" id="clip-drop">Import path or drop file…</div>
    <button class="btn btn-secondary" data-act="import-path" style="width:100%">Browse path…</button>`;
}

function renderCard(c) {
  const sel = '';
  if (c.type === 'audience') {
    const a = state.board.board.audience || {};
    return `<article class="card audience" data-card="${escapeHtml(c.id)}" style="left:${c.x}px;top:${c.y}px;width:${c.w || 280}px">
      <h3 class="card-title" contenteditable="true">${escapeHtml(c.title || 'Audience')}</h3>
      <dl class="kv">
        <dt>Persona</dt><dd contenteditable="true" data-aud="persona">${escapeHtml(a.persona || a.who || '')}</dd>
        <dt>Already knows</dt><dd contenteditable="true" data-aud="alreadyKnow">${escapeHtml(a.alreadyKnow || '')}</dd>
        <dt>Hook promise</dt><dd contenteditable="true" data-aud="promise">${escapeHtml(a.promise || '')}</dd>
      </dl>
    </article>`;
  }
  if (c.type === 'beat') {
    const beat = (state.board.beats || []).find((x) => x.cardId === c.id || x.id === c.data?.beatId);
    const target = beat?.data?.targetSec;
    const plan = beat?.plannedSec ?? c.data?.plannedSec;
    const fit = c.data?.fit || (beat && beat.servesPromise === false ? 'weak' : 'ok');
    const fitCls = fit === 'weak' ? 'fit-weak' : 'fit-ok';
    const fitText = fit === 'weak' ? 'Weak fit — promise buried' : 'Fits persona';
    return `<article class="card beat" data-card="${escapeHtml(c.id)}" data-beat-card="${escapeHtml(beat?.id || '')}" style="left:${c.x}px;top:${c.y}px;width:${c.w || 200}px">
      <h3 class="card-title" contenteditable="true">${escapeHtml(c.title || beat?.label || 'Beat')}</h3>
      <div class="dur">target ${target != null ? fmt(target) : '—'} · plan ${plan != null ? fmt(plan) : '—'}</div>
      <div class="fit ${fitCls}">${fitText}</div>
    </article>`;
  }
  return `<article class="card note" data-card="${escapeHtml(c.id)}" style="left:${c.x}px;top:${c.y}px;width:${c.w || 220}px">
    <div class="card-body" contenteditable="true">${escapeHtml(c.body || c.title || '')}</div>
  </article>`;
}

function renderBeatLanes() {
  const beats = [...(state.board.beats || [])].sort((a, b) => a.ord - b.ord);
  if (!beats.length) return `<div class="meta" style="padding:12px">No beats — add from the canvas tools.</div>`;
  return beats.map((beat) => {
    const selected = beat.id === state.selectedBeatId ? 'selected' : '';
    const clips = (beat.data?.clips || []).map((cl, i) =>
      `<div class="clip-bar" style="left:${8 + i * 40}%;width:${Math.min(70, 78 - i * 20)}%;${i ? 'background:#d4cfc5;border-color:#b5aa98;color:#4a3f32' : ''}">${escapeHtml(cl.label || cl.name || 'clip')}</div>`
    ).join('');
    return `<div class="beat-lane ${selected}" data-beat="${escapeHtml(beat.id)}">
      <span class="label">${escapeHtml(beat.label || 'Beat')}</span>${clips}</div>`;
  }).join('');
}

function renderMiniCurve() {
  const parts = state.pacing?.parts || state.pacing?.curve || [];
  if (!parts.length) return '';
  const max = Math.max(...parts.map((p) => p.plannedSec || p.duration || 1), 1);
  return parts.map((p) => {
    const dur = p.plannedSec ?? p.duration ?? 0;
    const h = Math.max(12, Math.round((dur / max) * 100));
    const slow = p.slow || (p.targetSec != null && dur > p.targetSec);
    return `<b class="${slow ? 'slow' : ''}" style="height:${h}%"></b>`;
  }).join('');
}

function drawWires() {
  const svg = $('#wires');
  if (!svg || !state.board) return;
  const cards = Object.fromEntries(state.board.cards.map((c) => [c.id, c]));
  const paths = (state.board.wires || []).map((w) => {
    const a = cards[w.fromCardId]; const b = cards[w.toCardId];
    if (!a || !b) return '';
    const x1 = a.x + (a.w || 200); const y1 = a.y + 40;
    const x2 = b.x; const y2 = b.y + 40;
    const mx = (x1 + x2) / 2;
    return `<path d="M${x1} ${y1} C${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}" />`;
  }).join('');
  svg.innerHTML = paths;
}

function bindBoard() {
  bindCommon();
  const title = $('#board-title');
  title?.addEventListener('change', () => {
    state.board.board.title = title.value.trim() || 'Untitled';
    scheduleSave();
  });
  $$('.beat-lane').forEach((el) => {
    el.addEventListener('click', () => {
      state.selectedBeatId = el.dataset.beat;
      renderBoard();
    });
  });
  $$('[data-zoom]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const z = btn.dataset.zoom;
      if (z === '+') state.zoom = Math.min(2, state.zoom + 0.1);
      else if (z === '-') state.zoom = Math.max(0.4, state.zoom - 0.1);
      else state.zoom = 1;
      renderBoard();
    });
  });
  $$('[data-add]').forEach((btn) => {
    btn.addEventListener('click', () => addCard(btn.dataset.add));
  });

  // drag cards
  let drag = null;
  const world = $('#canvas-world');
  world?.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('[data-card]');
    if (!card || e.target.isContentEditable || e.target.closest('[contenteditable]')) return;
    const id = card.dataset.card;
    const c = state.board.cards.find((x) => x.id === id);
    if (!c) return;
    drag = { id, ox: e.clientX, oy: e.clientY, x: c.x, y: c.y };
    card.setPointerCapture?.(e.pointerId);
  });
  world?.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const c = state.board.cards.find((x) => x.id === drag.id);
    if (!c) return;
    c.x = drag.x + (e.clientX - drag.ox) / state.zoom;
    c.y = drag.y + (e.clientY - drag.oy) / state.zoom;
    const el = document.querySelector(`[data-card="${drag.id}"]`);
    if (el) { el.style.left = c.x + 'px'; el.style.top = c.y + 'px'; }
    drawWires();
  });
  world?.addEventListener('pointerup', () => {
    if (drag) { drag = null; scheduleSave(); }
  });

  // editable audience / titles
  sheet().addEventListener('focusout', (e) => {
    const t = e.target;
    if (t.dataset?.aud) {
      state.board.board.audience = state.board.board.audience || {};
      state.board.board.audience[t.dataset.aud] = t.textContent.trim();
      scheduleSave();
    }
    if (t.classList?.contains('card-title')) {
      const card = t.closest('[data-card]');
      const c = state.board.cards.find((x) => x.id === card?.dataset.card);
      if (c) {
        c.title = t.textContent.trim();
        const beat = state.board.beats.find((b) => b.cardId === c.id);
        if (beat) beat.label = c.title;
        scheduleSave();
      }
    }
    if (t.classList?.contains('card-body')) {
      const card = t.closest('[data-card]');
      const c = state.board.cards.find((x) => x.id === card?.dataset.card);
      if (c) { c.body = t.textContent; scheduleSave(); }
    }
  });

  $('#clip-drop')?.addEventListener('click', () => importPathPrompt());
  $$('[data-act="import-path"]').forEach((b) => b.addEventListener('click', importPathPrompt));
}

function addCard(type) {
  const id = 'card_' + Math.random().toString(36).slice(2, 10);
  const base = { id, type, title: type === 'beat' ? 'Beat' : type === 'audience' ? 'Audience' : '', body: '', x: 120 + Math.random() * 80, y: 80 + Math.random() * 80, w: type === 'beat' ? 200 : 240, h: 140, z: 1, data: {} };
  if (type === 'beat') {
    const beatId = 'beat_' + Math.random().toString(36).slice(2, 10);
    const ord = state.board.beats.length;
    state.board.beats.push({
      id: beatId, cardId: id, ord, label: 'Beat', plannedSec: 60,
      servesPromise: true, data: { targetSec: 60 },
    });
    base.title = 'Beat';
    base.data = { beatId, plannedSec: 60, fit: 'ok' };
  }
  if (type === 'audience') {
    state.board.board.audience = state.board.board.audience || { persona: '', alreadyKnow: '', promise: '' };
  }
  if (type === 'note') base.body = 'Note';
  state.board.cards.push(base);
  scheduleSave();
  renderBoard();
}

async function importPathPrompt() {
  const path = prompt('Absolute path to MKV / MOV (source will not be modified):');
  if (!path) return;
  await api('/api/media/import-path', { method: 'POST', body: { path, boardId: state.board.board.id } });
  await loadBoard(state.board.board.id);
  renderBoard();
}

/* ---------- Pace ---------- */
function renderPace() {
  const b = state.board;
  if (!b) return;
  const pacing = state.pacing || {};
  const hours = state.hours;
  const parts = pacing.parts || [];
  const slow = parts.filter((p) => p.slow);
  const headroom = pacing.headroomSec ?? ((b.board.targetRuntimeSec || 0) - (pacing.totalPlannedSec || 0));
  const hoursTotal = hours ? Number(hours.spentHours || 0) : 0;
  const cap = hours?.capHours ?? b.board.hoursCap ?? 30;
  const hoursPct = cap ? Math.min(100, (hoursTotal / cap) * 100) : 0;
  const hoursOn = hoursTotal > 0 || hours?.activityWatch?.ok;

  const maxCum = Math.max(pacing.targetRuntimeSec || 1, pacing.totalPlannedSec || 1, 1);
  const chartW = 640; const chartH = 160; const padL = 40; const padR = 20; const padT = 20; const padB = 20;
  const plotH = chartH - padT - padB;
  const n = Math.max(parts.length, 1);
  const pts = [];
  let cum = 0;
  parts.forEach((p, i) => {
    cum += p.plannedSec || 0;
    const x = padL + ((i + 1) / n) * (chartW - padL - padR);
    const y = padT + plotH - (cum / maxCum) * plotH;
    pts.push({ x, y, cum, overBy: p.overBy, label: p.label, slow: p.slow });
  });
  if (!pts.length) pts.push({ x: padL, y: padT + plotH, cum: 0 });
  const poly = [`${padL},${padT + plotH}`, ...pts.map((p) => `${p.x},${p.y}`)].join(' ');
  const area = `M${padL},${padT + plotH} ` + pts.map((p) => `L${p.x},${p.y}`).join(' ') + ` L${pts[pts.length - 1].x},${padT + plotH} Z`;
  const targetY = padT + plotH - ((pacing.targetRuntimeSec || 0) / maxCum) * plotH;

  const el = sheet();
  el.className = 'sheet';
  el.innerHTML = `
    <div class="sheet-pad">
      <div class="title-row">
        <div>
          <h1>Pace &amp; parts</h1>
          <p class="sub">${escapeHtml(b.board.title)} — planned length vs ${fmt(b.board.targetRuntimeSec)} target.${slow.length ? ` ${slow.map((s) => s.label).join(' + ')} run long.` : ''}</p>
        </div>
        <div class="actions">
          <button class="btn btn-secondary" data-act="back-board">Back to board</button>
          <button class="btn btn-primary" data-act="export-md">Export MD</button>
        </div>
      </div>
      <div class="kpis">
        <div class="kpi"><label>Planned</label><div class="val mono">${fmt(pacing.totalPlannedSec)}<span class="u">m</span></div><div class="delta">vs ${fmt(b.board.targetRuntimeSec)} target</div></div>
        <div class="kpi"><label>Headroom</label><div class="val mono">${fmt(Math.abs(headroom))}<span class="u">m</span></div><div class="delta ${headroom >= 0 ? 'ok' : 'bad'}">${headroom >= 0 ? 'under target' : 'over target'}</div></div>
        <div class="kpi"><label>Slow stretches</label><div class="val mono">${slow.length}</div><div class="delta ${slow.length ? 'bad' : 'ok'}">${slow.length ? escapeHtml(slow.map((s) => s.label).join(' + ')) : 'none'}</div></div>
        <div class="kpi"><label>Hours logged</label><div class="val mono">${hoursOn ? hoursTotal.toFixed(1) : '—'}${hoursOn ? `<span class="u">/ ${cap}</span>` : ''}</div><div class="delta">${hours?.activityWatch?.ok ? 'Resolve + OBS' : 'off · + log hours'}</div></div>
      </div>
      <div class="grid2">
        <section>
          <h2 style="font-size:16px;font-weight:500">Pace curve</h2>
          <p class="muted" style="font-size:14px;margin:4px 0 16px">Cumulative planned duration by beat. Amber marks beats over their own target.</p>
          <div class="chart-box">
            <div class="chart-legend">
              <span><i class="dot" style="background:var(--chart-1)"></i>Planned cumulative</span>
              <span><i class="dot" style="background:var(--text);width:12px;height:1px;border-radius:0;vertical-align:middle;display:inline-block"></i>Target ${fmt(b.board.targetRuntimeSec)}</span>
              <span><i class="dot" style="background:var(--chart-3)"></i>Over part target</span>
            </div>
            <svg viewBox="0 0 ${chartW} ${chartH}" preserveAspectRatio="none" style="width:100%;height:160px;display:block">
              <line x1="${padL}" y1="${padT}" x2="${chartW - padR}" y2="${padT}" stroke="var(--grid)"/>
              <line x1="${padL}" y1="${padT + plotH / 3}" x2="${chartW - padR}" y2="${padT + plotH / 3}" stroke="var(--grid)"/>
              <line x1="${padL}" y1="${padT + 2 * plotH / 3}" x2="${chartW - padR}" y2="${padT + 2 * plotH / 3}" stroke="var(--grid)"/>
              <line x1="${padL}" y1="${padT + plotH}" x2="${chartW - padR}" y2="${padT + plotH}" stroke="var(--grid)"/>
              <line x1="${padL}" y1="${targetY}" x2="${chartW - padR}" y2="${targetY}" stroke="var(--text)" stroke-dasharray="4 4"/>
              <path d="${area}" fill="var(--chart-1)" opacity="0.08"/>
              <polyline points="${poly}" fill="none" stroke="var(--chart-1)" stroke-width="2"/>
              ${pts.filter((p) => p.slow).map((p) => `
                <circle cx="${p.x}" cy="${p.y}" r="4" fill="var(--chart-3)"/>
                <text x="${p.x + 8}" y="${p.y - 6}" font-size="10" fill="var(--warning)" font-family="IBM Plex Sans, sans-serif">${fmtSigned(p.overBy)}</text>
              `).join('')}
            </svg>
            <div class="plan-labels" style="font-size:11px;color:var(--muted)">
              ${parts.map((p) => `<span>${escapeHtml((p.label || '').split(' ')[0] || '·')}</span>`).join('')}
            </div>
          </div>
          <div style="border:1px solid var(--border);border-radius:8px;padding:16px;margin-top:16px">
            <h3 style="font-size:14px;font-weight:500;margin-bottom:4px">Hours against cap</h3>
            <p class="muted" style="font-size:12px;margin-bottom:12px">Read-only from ActivityWatch (Resolve, OBS) or hand-logged. Cap ${cap} h for this board.</p>
            ${hoursOn ? `
              <div class="plan-track"><div class="fill" style="width:${hoursPct}%"></div></div>
              <div class="plan-labels"><span>${hoursTotal.toFixed(1)} h</span><span>${cap} h</span></div>
              <div style="margin-top:12px;font-size:13px"><button class="btn-link" data-act="log-hours">+ log hours</button> · ${hours?.activityWatch?.ok ? 'ActivityWatch connected' : 'manual'}</div>
            ` : `
              <div class="hours-off-bar" style="margin:0">
                <span class="label">Hours off</span>
                <span>No ActivityWatch · no manual log yet</span>
                <div class="actions"><button class="btn-link" data-act="log-hours">+ log hours</button></div>
              </div>
            `}
          </div>
        </section>
        <section>
          <h2 style="font-size:16px;font-weight:500">Parts</h2>
          <p class="muted" style="font-size:14px;margin:4px 0 16px">Each beat vs its own target. Flagged rows are over.</p>
          <div class="parts">
            <table>
              <thead><tr><th>Beat</th><th class="num">Plan</th><th class="num">Target</th><th>Fit</th></tr></thead>
              <tbody>
                ${parts.map((p) => {
                  const ratio = p.targetSec ? Math.min(160, (p.plannedSec / p.targetSec) * 100) : 0;
                  return `<tr class="${p.slow ? 'flag' : ''}">
                    <td>${escapeHtml(p.label)}</td>
                    <td class="num">${fmt(p.plannedSec)}</td>
                    <td class="num">${p.targetSec != null ? fmt(p.targetSec) : '—'}</td>
                    <td><span class="bullet"><i style="width:${ratio}%;${p.slow ? 'background:var(--chart-3)' : ''}"></i></span>${p.slow ? `<span style="color:var(--warning);font-size:12px;font-weight:500">${fmtSigned(p.overBy)}</span>` : ''}</td>
                  </tr>`;
                }).join('')}
                <tr>
                  <td style="font-weight:500">Total</td>
                  <td class="num" style="font-weight:500">${fmt(pacing.totalPlannedSec)}</td>
                  <td class="num">${fmt(b.board.targetRuntimeSec)}</td>
                  <td style="color:var(--positive);font-size:12px">${headroom >= 0 ? fmt(headroom) + ' under' : fmtSigned(-headroom) + ' over'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>`;
  bindCommon();
}

/* ---------- Pipeline / Library ---------- */
function renderPipeline() {
  const el = sheet();
  el.className = 'sheet';
  el.innerHTML = `
    <div class="sheet-pad">
      <div class="title-row">
        <div>
          <h1>Pipeline</h1>
          <p class="sub">Notion idea inbox. Filter by stage; open or create a ${escapeHtml(APP_NAME)} board from a card.</p>
        </div>
        <div class="actions">
          <button class="btn btn-secondary" data-act="refresh-pipeline">Refresh</button>
          <button class="btn btn-primary" data-act="import-pipeline">Import to boards</button>
        </div>
      </div>
      ${state.pipeline.length ? `
        <div class="parts"><table>
          <thead><tr><th>Title</th><th>Stage</th><th>Persona</th><th>Week</th></tr></thead>
          <tbody>
            ${state.pipeline.map((idea) => `
              <tr data-idea="${escapeHtml(idea.notionPageId)}">
                <td>${escapeHtml(idea.title)}</td>
                <td>${stagePill(idea.stage || 'unstaged')}</td>
                <td>${escapeHtml(idea.persona || '—')}</td>
                <td class="mono">${escapeHtml(idea.targetWeek || '—')}</td>
              </tr>`).join('')}
          </tbody>
        </table></div>` : `
        <div class="empty-boards">
          <h2>No pipeline cards</h2>
          <p>Connect Notion and confirm mapping to pull Video pipeline cards here.</p>
          <div class="row"><button class="btn btn-primary" data-act="connect-notion">Connect Notion</button></div>
        </div>`}
    </div>`;
  bindCommon();
}

function renderLibrary() {
  const el = sheet();
  el.className = 'sheet';
  el.innerHTML = `
    <div class="sheet-pad">
      <div class="title-row">
        <div><h1>Library</h1><p class="sub">Imported clips and proxy status. Sources are never rewritten.</p></div>
        <div class="actions"><button class="btn btn-primary" data-act="import-path-global">Import path…</button></div>
      </div>
      <div id="lib-list" class="board-list"><p class="muted">Loading…</p></div>
    </div>`;
  bindCommon();
  api('/api/media').then((data) => {
    const list = data.media || [];
    const box = $('#lib-list');
    if (!list.length) {
      box.innerHTML = `<div class="empty-boards"><h2>No clips</h2><p>Import MKV or ProRes/DNxHR MOV. Proxies build in the background.</p></div>`;
      return;
    }
    box.innerHTML = list.map((m) => {
      const name = (m.sourcePath || '').split('/').pop();
      return `<div class="board-row">
        <div><div class="name">${escapeHtml(name)}</div><div class="meta mono">${escapeHtml(m.sourcePath)}</div></div>
        <div class="mono">${fmt(m.durationSec)}</div>
        <div><span class="pill ${m.status === 'ready' ? 'pill-proxy' : 'pill-warn'}">${escapeHtml(m.status)}</span></div>
        <div class="meta">${Math.round((m.progress || 0) * 100)}%</div>
      </div>`;
    }).join('');
  }).catch(() => { $('#lib-list').innerHTML = `<p class="muted">Could not load media.</p>`; });
}

/* ---------- Notion mapping ---------- */
function renderNotion() {
  const s = state.settings || {};
  const notion = s.notion || {};
  const mapping = notion.mapping || {};
  const fields = [
    ['title', 'Title'],
    ['stage', 'Stage'],
    ['persona', 'Persona'],
    ['leave_behind', 'Leave-behind'],
    ['link', 'Link'],
    ['target_week', 'Target week'],
  ];
  const suggested = state.notionSchema?.suggestedMapping || mapping;
  const propNames = Object.keys(state.notionSchema?.properties || {});
  const confirmed = !!notion.mappingConfirmed;
  const demo = state.demo || state.route.demoConflict;

  const mapRows = fields.map(([key, label]) => {
    const value = suggested[key] || mapping[key] || '';
    const isDefault = !!(suggested[key] || mapping[key]);
    const demoNames = { title: 'Name', stage: 'stage', persona: 'persona', leave_behind: 'leave-behind', link: 'link', target_week: 'target week' };
    const display = demo && !propNames.length ? (demoNames[key] || value) : value;
    const options = propNames.length
      ? propNames.map((n) => `<option value="${escapeHtml(n)}" ${n === value ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')
      : `<option selected>${escapeHtml(display || '—')}</option>`;
    return `<div class="map-row">
      <div class="map-field"><span>${label}</span></div>
      <div class="arrow">→</div>
      <div class="map-field">
        <select class="input" data-map="${key}" style="border:0;height:100%;padding:0;background:transparent">
          ${options}
        </select>
        ${isDefault ? '<span class="chip-pre">Default</span>' : ''}
      </div>
    </div>`;
  }).join('');

  const previewIdeas = demo ? [
    { title: 'Local LLM on a $200 mini PC', stage: 'Draft', persona: 'Home lab', targetWeek: 'W46' },
    { title: 'Fine-tune vs RAG for a shop FAQ', stage: 'Draft', persona: 'Builder', targetWeek: 'W47' },
    { title: 'OBS replay buffer as a research log', stage: 'unstaged', persona: 'Creator', targetWeek: '' },
  ] : state.pipeline.slice(0, 5);

  const conflictHtml = (state.conflict || (demo ? {
    conflict: true,
    diffs: [{ field: 'title', local: 'Local LLM on a $200 mini PC', remote: 'Local LLM on a cheap mini PC' }],
    local: { title: 'Local LLM on a $200 mini PC' },
    remote: { title: 'Local LLM on a cheap mini PC' },
    localUpdatedAt: new Date().toISOString(),
    remoteStamp: new Date().toISOString(),
  } : null));

  const el = sheet();
  el.className = 'sheet';
  el.innerHTML = `
    <div class="sheet-pad" style="gap:16px;padding:20px 28px 18px">
      <div class="title-row">
        <div>
          <h1>Notion</h1>
          <p class="sub">${demo ? 'Video pipeline detected. Mapping is pre-filled. Confirm once; stage and title sync both ways.' : (state.notionSchema ? escapeHtml(state.notionSchema.title) + ' detected. Mapping is pre-filled. Confirm once; stage and title sync both ways.' : 'Connect a database. Mapping opens pre-filled from detected fields — confirm only.')}</p>
        </div>
        ${demo ? '<span class="pill">Demo layout</span>' : ''}
      </div>
      <div class="cols">
        <div class="col">
          <div><h2>Connection</h2><p class="desc">${demo ? '47 cards in Video pipeline.' : (state.pipeline.length ? state.pipeline.length + ' cards in pipeline.' : 'Token + database required.')}</p></div>
          <div class="panel">
            <div class="status-line">
              <span class="${(notion.tokenSet || demo) ? 'dot-live' : 'dot-off'}"></span>
              ${demo ? 'Connected · last sync demo Europe/Istanbul' : (notion.tokenSet ? `Connected · mapping ${confirmed ? 'confirmed' : 'pending confirm'}` : 'Not connected')}
            </div>
            ${demo ? `
            <div class="field"><label>Workspace</label><div class="map-field">Demo workspace</div></div>
            <div class="field"><label>Database</label><div class="map-field"><span>Video pipeline</span><span class="chip-pre">Matched</span></div></div>
            ` : `
            <div class="field">
              <label>Integration token</label>
              <input class="input" id="notion-token" type="password" placeholder="${notion.tokenSet ? 'Token set — paste to replace' : 'secret_…'}" />
            </div>
            <div class="field">
              <label>Database</label>
              <div style="display:flex;gap:8px">
                <select class="input" id="notion-db"><option value="">${notion.databaseId ? escapeHtml(notion.databaseId) : 'Select…'}</option></select>
                <button class="btn btn-secondary" data-act="load-dbs">Refresh</button>
              </div>
            </div>
            <div class="actions" style="justify-content:flex-start;margin-top:8px">
              <button class="btn btn-primary" data-act="save-token">Save connection</button>
            </div>`}
          </div>
          <div><h2>Field mapping</h2><p class="desc">Defaults for stage, persona, leave-behind, link, target week. Confirm or change if renamed.</p></div>
          <div class="panel">
            ${mapRows}
            <p class="muted" style="font-size:12px;margin-top:8px">Stage values: Publish, Draft, unstaged. Title + stage sync both ways.</p>
            <div class="actions" style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
              <button class="btn btn-ghost" data-act="reload-schema">Change mapping</button>
              <button class="btn btn-primary" data-act="confirm-mapping">Confirm mapping</button>
            </div>
          </div>
        </div>
        <div class="col">
          <div><h2>Sync &amp; conflicts</h2><p class="desc">Stage and title write back. Resolve conflicts before the next push.</p></div>
          <div class="panel pipeline-preview">
            <div class="row head"><span>Title</span><span>Stage</span><span>Persona</span><span>Week</span></div>
            ${previewIdeas.length ? previewIdeas.map((idea) => `
              <div class="row">
                <span>${escapeHtml(idea.title)}</span>
                ${stagePill(idea.stage)}
                <span>${escapeHtml(idea.persona || '—')}</span>
                <span class="mono" style="font-size:12px">${escapeHtml(idea.targetWeek || '—')}</span>
              </div>`).join('') : '<p class="muted" style="padding:8px 0">No preview rows yet.</p>'}
          </div>
          ${conflictHtml?.conflict ? `
            <div class="conflict" id="conflict-box">
              <h3>Conflict on “${escapeHtml(conflictHtml.local?.title || conflictHtml.diffs?.[0]?.local || 'board')}”</h3>
              <p>Title differs. Local edited ${escapeHtml(istanbul(conflictHtml.localUpdatedAt))} · Notion edited ${escapeHtml(istanbul(conflictHtml.remoteStamp))}.</p>
              <div class="boxes">
                <div class="box"><strong>Local</strong>${escapeHtml(conflictHtml.diffs?.[0]?.local || conflictHtml.local?.title || '')}</div>
                <div class="box"><strong>Notion</strong>${escapeHtml(conflictHtml.diffs?.[0]?.remote || conflictHtml.remote?.title || '')}</div>
              </div>
              <div class="btns">
                <button class="btn btn-secondary" data-act="keep-local">Keep local</button>
                <button class="btn btn-secondary" data-act="keep-notion">Keep Notion</button>
                <button class="btn btn-ghost" data-act="edit-conflict">Edit…</button>
              </div>
            </div>` : `<p class="muted" style="font-size:13px">No open conflicts.</p>`}
        </div>
      </div>
    </div>`;
  bindCommon();
  bindNotion();
}

function bindNotion() {
  $$('[data-act="load-dbs"]').forEach((b) => b.addEventListener('click', loadDatabases));
  $$('[data-act="save-token"]').forEach((b) => b.addEventListener('click', saveNotionConnection));
  $$('[data-act="confirm-mapping"]').forEach((b) => b.addEventListener('click', confirmMapping));
  $$('[data-act="reload-schema"]').forEach((b) => b.addEventListener('click', async () => {
    await loadNotionSchema();
    renderNotion();
  }));
  $$('[data-act="keep-local"]').forEach((b) => b.addEventListener('click', () => resolveConflict('keep_local')));
  $$('[data-act="keep-notion"]').forEach((b) => b.addEventListener('click', () => resolveConflict('keep_notion')));
  $$('[data-act="edit-conflict"]').forEach((b) => b.addEventListener('click', editConflict));
}

async function loadDatabases() {
  try {
    const data = await api('/api/notion/databases');
    const sel = $('#notion-db');
    if (!sel) return;
    sel.innerHTML = (data.databases || []).map((d) =>
      `<option value="${escapeHtml(d.id)}" ${d.id === state.settings?.notion?.databaseId ? 'selected' : ''}>${escapeHtml(d.title)}</option>`
    ).join('') || '<option value="">No databases</option>';
  } catch (err) {
    alert(err.message || 'Could not list databases');
  }
}

async function saveNotionConnection() {
  const token = $('#notion-token')?.value?.trim();
  const databaseId = $('#notion-db')?.value || state.settings?.notion?.databaseId;
  const body = { notion: {} };
  if (token) body.notion.token = token;
  if (databaseId) body.notion.databaseId = databaseId;
  state.settings = await api('/api/settings', { method: 'PUT', body });
  if (databaseId) await loadNotionSchema(databaseId);
  await loadPipeline();
  renderNotion();
}

async function loadNotionSchema(databaseId) {
  try {
    const q = databaseId || state.settings?.notion?.databaseId;
    if (!q) return;
    state.notionSchema = await api(`/api/notion/schema?databaseId=${encodeURIComponent(q)}`);
  } catch {
    state.notionSchema = null;
  }
}

async function confirmMapping() {
  const mapping = { ...(state.settings?.notion?.mapping || {}) };
  $$('[data-map]').forEach((sel) => { mapping[sel.dataset.map] = sel.value; });
  const databaseId = $('#notion-db')?.value || state.settings?.notion?.databaseId;
  await api('/api/notion/mapping', { method: 'POST', body: { mapping, databaseId, confirmed: true } });
  state.settings = await loadSettings();
  alert('Mapping confirmed. Stage and title will sync both ways.');
  renderNotion();
}

async function resolveConflict(action) {
  if (state.demo && !state.conflict?.boardId) {
    state.conflict = null;
    state.demo = false;
    renderNotion();
    return;
  }
  const boardId = state.conflict?.boardId || state.board?.board?.id;
  if (!boardId) return;
  try {
    await api(`/api/notion/boards/${boardId}/resolve`, { method: 'POST', body: { action } });
    state.conflict = null;
    await loadBoards();
    renderNotion();
  } catch (err) {
    alert(err.message || 'Resolve failed');
  }
}

function editConflict() {
  const local = state.conflict?.local?.title || state.conflict?.diffs?.[0]?.local || '';
  const next = prompt('Edit title to push to Notion:', local);
  if (next == null) return;
  const boardId = state.conflict?.boardId || state.board?.board?.id;
  if (!boardId) {
    state.conflict = null;
    renderNotion();
    return;
  }
  api(`/api/notion/boards/${boardId}/resolve`, {
    method: 'POST',
    body: { action: 'edit', title: next },
  }).then(() => {
    state.conflict = null;
    return loadBoards();
  }).then(() => renderNotion()).catch((err) => alert(err.message));
}

/* ---------- Settings ---------- */
function renderSettings() {
  const s = state.settings || {};
  const el = sheet();
  el.className = 'sheet';
  el.innerHTML = `
    <div class="sheet-pad">
      <div class="title-row">
        <div><h1>Settings</h1><p class="sub">${escapeHtml(APP_NAME)} · local only · light mode in v1</p></div>
      </div>
      <div class="setup" style="grid-template-columns:1fr 1fr 1fr">
        <div class="step" style="cursor:pointer" data-act="connect-notion">
          <div class="n">Notion</div>
          <h2>Connect &amp; mapping</h2>
          <p>Pre-filled field map · confirm once · two-way stage + title</p>
        </div>
        <div class="step">
          <div class="n">Hours</div>
          <h2>Cap &amp; ActivityWatch</h2>
          <p>Default cap ${s.hours?.defaultCapHours ?? 30} h. Read-only AW for Resolve + OBS.</p>
          <div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">
            <label class="muted" style="font-size:12px">Default hours cap
              <input class="input" id="cap-hours" type="number" value="${s.hours?.defaultCapHours ?? 30}" />
            </label>
            <label class="muted" style="font-size:12px;display:flex;gap:8px;align-items:center">
              <input type="checkbox" id="aw-enabled" ${s.hours?.activityWatch?.enabled ? 'checked' : ''}/> Enable ActivityWatch
            </label>
            <input class="input" id="aw-url" value="${escapeHtml(s.hours?.activityWatch?.baseUrl || 'http://localhost:5600')}" />
            <button class="btn btn-primary" data-act="save-hours-settings">Save hours</button>
          </div>
        </div>
        <div class="step">
          <div class="n">Appearance</div>
          <h2>Light only (v1)</h2>
          <p>Dark tokens are ready but not offered yet.</p>
        </div>
      </div>
    </div>`;
  bindCommon();
  $$('[data-act="save-hours-settings"]').forEach((b) => b.addEventListener('click', async () => {
    const body = {
      hours: {
        defaultCapHours: Number($('#cap-hours').value) || 30,
        activityWatch: {
          enabled: $('#aw-enabled').checked,
          baseUrl: $('#aw-url').value.trim(),
        },
      },
    };
    state.settings = await api('/api/settings', { method: 'PUT', body });
    alert('Hours settings saved');
  }));
}

/* ---------- shared actions ---------- */
function bindCommon() {
  $$('[data-act="new-board"]').forEach((b) => b.addEventListener('click', newBoard));
  $$('[data-act="connect-notion"]').forEach((b) => b.addEventListener('click', () => navigate('#/settings/notion')));
  $$('[data-act="hours-settings"]').forEach((b) => b.addEventListener('click', () => navigate('#/settings')));
  $$('[data-act="back-boards"]').forEach((b) => b.addEventListener('click', () => navigate('#/boards')));
  $$('[data-act="back-board"]').forEach((b) => b.addEventListener('click', () => {
    if (state.board?.board?.id) navigate(`#/board/${state.board.board.id}`);
    else navigate('#/boards');
  }));
  $$('[data-act="open-pace"]').forEach((b) => b.addEventListener('click', () => {
    if (state.board?.board?.id) navigate(`#/board/${state.board.board.id}/pace`);
  }));
  $$('[data-act="export-md"]').forEach((b) => b.addEventListener('click', exportMd));
  $$('[data-act="sync-board"]').forEach((b) => b.addEventListener('click', syncBoard));
  $$('[data-act="log-hours"], [data-act="log-hours-global"]').forEach((b) => b.addEventListener('click', logHours));
  $$('[data-act="refresh-pipeline"]').forEach((b) => b.addEventListener('click', async () => { await loadPipeline(); render(); }));
  $$('[data-act="import-pipeline"]').forEach((b) => b.addEventListener('click', async () => {
    await api('/api/notion/import', { method: 'POST', body: { createBoards: true } });
    await loadBoards();
    navigate('#/boards');
  }));
  $$('[data-act="import-path-global"]').forEach((b) => b.addEventListener('click', async () => {
    const path = prompt('Absolute path to media file:');
    if (!path) return;
    await api('/api/media/import-path', { method: 'POST', body: { path } });
    renderLibrary();
  }));
  $$('[data-open-board]').forEach((row) => {
    row.addEventListener('click', () => navigate(`#/board/${row.dataset.openBoard}`));
  });
}

async function newBoard() {
  const title = prompt('Board title', 'Untitled video');
  if (title == null) return;
  const data = await api('/api/boards', {
    method: 'POST',
    body: {
      title: title.trim() || 'Untitled video',
      targetRuntimeSec: 14 * 60,
      hoursCap: state.settings?.hours?.defaultCapHours ?? 30,
      status: 'Draft',
    },
  });
  navigate(`#/board/${data.board.id}`);
}

async function exportMd() {
  const id = state.board?.board?.id;
  if (!id) return;
  const res = await fetch(`/api/export/${id}/markdown`);
  const text = await res.text();
  const blob = new Blob([text], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(state.board.board.title || 'board').replace(/\W+/g, '-').toLowerCase()}.md`;
  a.click();
}

async function syncBoard() {
  const id = state.board?.board?.id;
  if (!id) return;
  if (!state.board.board.notionPageId) {
    alert('Link this board to a Notion page first (import from Pipeline).');
    return;
  }
  try {
    await api(`/api/notion/boards/${id}/push`, { method: 'POST', body: {} });
    alert('Synced title + stage to Notion');
  } catch (err) {
    if (err.status === 409 && err.data) {
      state.conflict = { ...err.data, boardId: id, local: { title: state.board.board.title, stage: state.board.board.status }, localUpdatedAt: state.board.board.updatedAt };
      navigate('#/settings/notion');
      return;
    }
    alert(err.message || 'Sync failed');
  }
}

async function logHours() {
  const id = state.board?.board?.id || state.boards[0]?.id;
  if (!id) {
    alert('Open a board first to log hours against it.');
    return;
  }
  const raw = prompt('Hours to add (e.g. 1.5):', '1');
  if (raw == null) return;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || !hours) return;
  await api(`/api/hours/${id}/entries`, { method: 'POST', body: { hours, note: 'manual' } });
  if (state.board?.board?.id === id) {
    state.hours = await api(`/api/hours/${id}`);
    render();
  } else {
    alert('Logged.');
  }
}

/* ---------- router ---------- */
async function onRoute() {
  state.route = parseHash();
  try {
    if (!state.settings) await loadSettings();
    if (state.route.name === 'boards') {
      await loadBoards();
    } else if (state.route.name === 'board' || state.route.name === 'pace') {
      await loadBoard(state.route.boardId);
    } else if (state.route.name === 'pipeline') {
      await loadPipeline();
    } else if (state.route.name === 'notion') {
      await loadSettings();
      await loadNotionSchema();
      await loadPipeline();
      // check conflicts for linked boards (best-effort)
      if (!state.demo) {
        for (const b of (await loadBoards())) {
          if (!b.notionPageId) continue;
          try {
            const c = await api(`/api/notion/boards/${b.id}/conflict`);
            if (c.conflict) { state.conflict = { ...c, boardId: b.id }; break; }
          } catch { /* ignore */ }
        }
      }
    } else if (state.route.name === 'settings' || state.route.name === 'hours-settings') {
      await loadSettings();
    }
  } catch (err) {
    console.error(err);
  }
  render();
}

$$('.nav-item').forEach((el) => {
  el.addEventListener('click', () => {
    const n = el.dataset.nav;
    if (n === 'boards') navigate('#/boards');
    else if (n === 'pipeline') navigate('#/pipeline');
    else if (n === 'library') navigate('#/library');
    else if (n === 'settings') navigate('#/settings');
  });
});

window.addEventListener('hashchange', onRoute);
if (!location.hash) location.hash = '#/boards';
else onRoute();
