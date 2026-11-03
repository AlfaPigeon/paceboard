import { Router } from 'express';
import { loadSettings, saveSettings } from '../config.js';
import { getDb, nowIso } from '../db.js';
import { id } from '../util.js';
import {
  buildPropertyUpdates,
  detectConflict,
  fetchDataSourceRows,
  formatNotionError,
  getClientFromSettings,
  getDataSourceSchema,
  listDataSources,
  pageToIdea,
  resolveToDataSources,
  retrievePage,
  updatePage,
} from '../services/notion.js';
import { loadBoardBundle } from './boards.js';

const r = Router();

function sendNotionError(res, err, { label } = {}) {
  const settings = loadSettings();
  const friendlyLabel = label
    || settings.notion?.databaseTitle
    || (settings.notion?.dataSourceId && settings.notion?.mapping?.title)
    || null;
  // Prefer schema/database display name when we have one stored on the request path
  const formatted = formatNotionError(err, {
    label: friendlyLabel || label || 'Notion',
  });
  const status = err?.status && err.status >= 400 && err.status < 600 ? err.status : 502;
  res.status(status >= 500 || status === 429 ? status : 502).json({
    error: formatted.message,
    title: formatted.title,
    details: formatted.details,
    code: formatted.code,
    status: formatted.status,
  });
}

r.get('/databases', async (_req, res) => {
  // Backward-compatible alias — returns data sources (API 2025-09-03+)
  try {
    const client = getClientFromSettings();
    if (!client) return res.status(400).json({ error: 'Notion token not configured' });
    const databases = await listDataSources(client);
    res.json({ databases, dataSources: databases });
  } catch (err) {
    sendNotionError(res, err);
  }
});

r.get('/data-sources', async (_req, res) => {
  try {
    const client = getClientFromSettings();
    if (!client) return res.status(400).json({ error: 'Notion token not configured' });
    const dataSources = await listDataSources(client);
    res.json({ dataSources, databases: dataSources });
  } catch (err) {
    sendNotionError(res, err);
  }
});

r.post('/resolve', async (req, res) => {
  try {
    const client = getClientFromSettings();
    if (!client) return res.status(400).json({ error: 'Notion token not configured' });
    const input = req.body?.url || req.body?.id || req.body?.input || '';
    const result = await resolveToDataSources(client, input);
    res.json(result);
  } catch (err) {
    sendNotionError(res, err);
  }
});

r.get('/schema', async (req, res) => {
  try {
    const settings = loadSettings();
    const dataSourceId = req.query.dataSourceId || req.query.databaseId || settings.notion.dataSourceId || settings.notion.databaseId;
    if (!dataSourceId) return res.status(400).json({ error: 'dataSourceId required' });
    const client = getClientFromSettings(settings);
    if (!client) return res.status(400).json({ error: 'Notion token not configured' });
    const schema = await getDataSourceSchema(client, dataSourceId);
    res.json(schema);
  } catch (err) {
    const settings = loadSettings();
    const label = settings.notion?.databaseTitle || 'Notion';
    // Try to use query id label later; fall back
    sendNotionError(res, err, { label: req.query.label || label });
  }
});

r.post('/mapping', (req, res) => {
  const settings = loadSettings();
  const mapping = { ...settings.notion.mapping, ...(req.body?.mapping || {}) };
  const dataSourceId = req.body?.dataSourceId || settings.notion.dataSourceId || '';
  const databaseId = req.body?.databaseId || settings.notion.databaseId || '';
  const databaseTitle = req.body?.databaseTitle ?? settings.notion.databaseTitle ?? '';
  const mappingConfirmed = req.body?.confirmed != null
    ? !!req.body.confirmed
    : (settings.notion.mappingConfirmed || false);
  const saved = saveSettings({
    ...settings,
    notion: {
      ...settings.notion,
      mapping,
      dataSourceId,
      databaseId,
      databaseTitle,
      mappingConfirmed,
    },
  });
  res.json({
    mapping: saved.notion.mapping,
    dataSourceId: saved.notion.dataSourceId,
    databaseId: saved.notion.databaseId,
    mappingConfirmed: saved.notion.mappingConfirmed,
  });
});

r.post('/import', async (req, res) => {
  try {
    const settings = loadSettings();
    const dataSourceId = req.body?.dataSourceId || settings.notion.dataSourceId || settings.notion.databaseId;
    if (!dataSourceId) return res.status(400).json({ error: 'dataSourceId required' });
    const client = getClientFromSettings(settings);
    if (!client) return res.status(400).json({ error: 'Notion token not configured' });
    const rows = await fetchDataSourceRows(client, dataSourceId);
    const mapping = settings.notion.mapping;
    const ideas = rows.map((page) => pageToIdea(page, mapping));

    const createBoards = req.body?.createBoards !== false;
    const created = [];
    if (createBoards) {
      const db = getDb();
      const ts = nowIso();
      for (const idea of ideas) {
        const existing = db.prepare('SELECT id FROM boards WHERE notion_page_id = ?').get(idea.notionPageId);
        if (existing) {
          db.prepare(`
            UPDATE boards SET title=?, status=?, notion_last_edited=?, audience_json=?, updated_at=?
            WHERE id=?
          `).run(
            idea.title,
            idea.stage || 'idea',
            idea.notionLastEdited,
            JSON.stringify({
              who: '',
              alreadyKnow: '',
              promise: idea.leaveBehind || '',
              persona: idea.persona || '',
            }),
            ts,
            existing.id,
          );
          created.push({ id: existing.id, updated: true, title: idea.title });
          continue;
        }
        const boardId = id('board');
        db.prepare(`
          INSERT INTO boards (id, title, status, notion_page_id, notion_last_edited, target_runtime_sec,
            hours_cap, hours_manual, hours_aw_filter, hours_aw_start, audience_json, meta_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 600, ?, 0, NULL, NULL, ?, ?, ?, ?)
        `).run(
          boardId,
          idea.title,
          idea.stage || 'idea',
          idea.notionPageId,
          idea.notionLastEdited,
          settings.hours?.defaultCapHours ?? 30,
          JSON.stringify({
            who: '',
            alreadyKnow: '',
            promise: idea.leaveBehind || '',
            persona: idea.persona || '',
          }),
          JSON.stringify({ link: idea.link, targetWeek: idea.targetWeek, raw: idea.raw }),
          ts,
          ts,
        );
        const cardId = id('card');
        db.prepare(`
          INSERT INTO cards (id, board_id, type, title, body, x, y, w, h, z, group_id, data_json, created_at, updated_at)
          VALUES (?, ?, 'audience', 'Audience', '', 40, 40, 280, 200, 1, NULL, '{}', ?, ?)
        `).run(cardId, boardId, ts, ts);
        created.push({ id: boardId, updated: false, title: idea.title });
      }
    }

    res.json({ count: ideas.length, ideas, created });
  } catch (err) {
    const settings = loadSettings();
    sendNotionError(res, err, { label: settings.notion?.databaseTitle || 'Notion' });
  }
});

r.post('/boards/:id/push', async (req, res) => {
  try {
    const settings = loadSettings();
    const client = getClientFromSettings(settings);
    if (!client) return res.status(400).json({ error: 'Notion token not configured' });
    const bundle = loadBoardBundle(req.params.id);
    if (!bundle) return res.status(404).json({ error: 'Board not found' });
    const pageId = bundle.board.notionPageId || req.body?.notionPageId;
    if (!pageId) return res.status(400).json({ error: 'Board is not linked to a Notion page' });

    const force = !!req.body?.force;
    const remote = await retrievePage(client, pageId);
    const remoteIdea = pageToIdea(remote, settings.notion.mapping);
    const localFields = {
      title: req.body?.title ?? bundle.board.title,
      stage: req.body?.stage ?? bundle.board.status,
      persona: req.body?.persona ?? bundle.board.audience?.persona,
      leave_behind: req.body?.leave_behind ?? bundle.board.audience?.promise,
      link: req.body?.link ?? bundle.board.meta?.link,
      target_week: req.body?.target_week ?? bundle.board.meta?.targetWeek,
    };
    const conflict = detectConflict({
      localStamp: bundle.board.notionLastEdited,
      remoteStamp: remote.last_edited_time,
      localFields,
      remoteIdea,
      mapping: settings.notion.mapping,
    });
    if (conflict.conflict && !force) {
      return res.status(409).json({ error: 'conflict', ...conflict, remote: remoteIdea });
    }

    const dsId = settings.notion.dataSourceId
      || remote.parent?.data_source_id
      || settings.notion.databaseId;
    const schema = await getDataSourceSchema(client, dsId);
    const properties = buildPropertyUpdates(localFields, settings.notion.mapping, schema.properties);
    const updated = await updatePage(client, pageId, properties);
    getDb().prepare(`
      UPDATE boards SET notion_last_edited = ?, title = ?, status = ?, updated_at = ? WHERE id = ?
    `).run(updated.last_edited_time, localFields.title, localFields.stage || bundle.board.status, nowIso(), req.params.id);

    res.json({ ok: true, notionLastEdited: updated.last_edited_time, conflict: conflict.conflict && force });
  } catch (err) {
    sendNotionError(res, err, { label: loadSettings().notion?.databaseTitle || 'Notion' });
  }
});

r.post('/boards/:id/resolve', async (req, res) => {
  try {
    const settings = loadSettings();
    const client = getClientFromSettings(settings);
    if (!client) return res.status(400).json({ error: 'Notion token not configured' });
    const bundle = loadBoardBundle(req.params.id);
    if (!bundle) return res.status(404).json({ error: 'Board not found' });
    const pageId = bundle.board.notionPageId || req.body?.notionPageId;
    if (!pageId) return res.status(400).json({ error: 'Board is not linked to a Notion page' });

    const action = req.body?.action; // keep_local | keep_notion | edit
    const remote = await retrievePage(client, pageId);
    const remoteIdea = pageToIdea(remote, settings.notion.mapping);
    const db = getDb();

    if (action === 'keep_notion') {
      const audience = {
        ...(bundle.board.audience || {}),
        persona: remoteIdea.persona || bundle.board.audience?.persona || '',
        promise: remoteIdea.leaveBehind || bundle.board.audience?.promise || '',
      };
      const meta = {
        ...(bundle.board.meta || {}),
        link: remoteIdea.link || bundle.board.meta?.link,
        targetWeek: remoteIdea.targetWeek || bundle.board.meta?.targetWeek,
      };
      db.prepare(`
        UPDATE boards SET title=?, status=?, audience_json=?, meta_json=?, notion_last_edited=?, updated_at=?
        WHERE id=?
      `).run(
        remoteIdea.title || bundle.board.title,
        remoteIdea.stage || bundle.board.status,
        JSON.stringify(audience),
        JSON.stringify(meta),
        remote.last_edited_time,
        nowIso(),
        req.params.id,
      );
      return res.json({ ok: true, action, board: loadBoardBundle(req.params.id)?.board, remote: remoteIdea });
    }

    if (action === 'keep_local' || action === 'edit') {
      const localFields = {
        title: req.body?.title ?? bundle.board.title,
        stage: req.body?.stage ?? bundle.board.status,
        persona: req.body?.persona ?? bundle.board.audience?.persona,
        leave_behind: req.body?.leave_behind ?? bundle.board.audience?.promise,
        link: req.body?.link ?? bundle.board.meta?.link,
        target_week: req.body?.target_week ?? bundle.board.meta?.targetWeek,
      };
      if (action === 'edit') {
        db.prepare(`
          UPDATE boards SET title=?, status=?, updated_at=? WHERE id=?
        `).run(localFields.title, localFields.stage || bundle.board.status, nowIso(), req.params.id);
      }
      const dsId = settings.notion.dataSourceId
        || remote.parent?.data_source_id
        || settings.notion.databaseId;
      const schema = await getDataSourceSchema(client, dsId);
      const properties = buildPropertyUpdates(localFields, settings.notion.mapping, schema.properties);
      const updated = await updatePage(client, pageId, properties);
      db.prepare(`
        UPDATE boards SET notion_last_edited=?, title=?, status=?, updated_at=? WHERE id=?
      `).run(updated.last_edited_time, localFields.title, localFields.stage || bundle.board.status, nowIso(), req.params.id);
      return res.json({ ok: true, action, notionLastEdited: updated.last_edited_time });
    }

    return res.status(400).json({ error: 'action must be keep_local, keep_notion, or edit' });
  } catch (err) {
    sendNotionError(res, err, { label: loadSettings().notion?.databaseTitle || 'Notion' });
  }
});

r.get('/boards/:id/conflict', async (req, res) => {
  try {
    const settings = loadSettings();
    const client = getClientFromSettings(settings);
    if (!client) return res.status(400).json({ error: 'Notion token not configured' });
    const bundle = loadBoardBundle(req.params.id);
    if (!bundle) return res.status(404).json({ error: 'Board not found' });
    const pageId = bundle.board.notionPageId;
    if (!pageId) return res.json({ conflict: false, linked: false });
    const remote = await retrievePage(client, pageId);
    const remoteIdea = pageToIdea(remote, settings.notion.mapping);
    const localFields = {
      title: bundle.board.title,
      stage: bundle.board.status,
      persona: bundle.board.audience?.persona,
      leave_behind: bundle.board.audience?.promise,
      link: bundle.board.meta?.link,
      target_week: bundle.board.meta?.targetWeek,
    };
    const conflict = detectConflict({
      localStamp: bundle.board.notionLastEdited,
      remoteStamp: remote.last_edited_time,
      localFields,
      remoteIdea,
      mapping: settings.notion.mapping,
    });
    res.json({ ...conflict, linked: true, local: localFields, remote: remoteIdea, localUpdatedAt: bundle.board.updatedAt, remoteStamp: remote.last_edited_time });
  } catch (err) {
    sendNotionError(res, err, { label: loadSettings().notion?.databaseTitle || 'Notion' });
  }
});

export default r;
