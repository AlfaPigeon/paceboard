import { Client, isNotionClientError } from '@notionhq/client';
import { loadSettings } from '../config.js';

/** Pin explicitly so an SDK bump cannot silently change API behavior. */
export const NOTION_VERSION = '2025-09-03';

export function createNotionClient(token) {
  if (!token) throw new Error('Notion token not configured');
  return new Client({ auth: token, notionVersion: NOTION_VERSION });
}

export function getClientFromSettings(settings = loadSettings()) {
  const token = settings.notion?.token;
  if (!token) return null;
  return createNotionClient(token);
}

/** Suggested mapping for common YouTube idea pipeline DBs (names only; no IDs). */
export const SUGGESTED_FIELD_MAP = {
  title: ['Video', 'Title', 'Name', 'Idea'],
  stage: ['Stage', 'Status', 'State'],
  persona: ['Persona', 'Audience', 'ICP'],
  leave_behind: ['Leave-behind', 'Leave behind', 'Takeaway', 'CTA'],
  link: ['Link', 'URL', 'Reference'],
  target_week: ['Target week', 'Week', 'Ship week', 'Target Week'],
};

export function suggestMapping(properties = {}) {
  const names = Object.keys(properties);
  const mapping = {};
  for (const [field, candidates] of Object.entries(SUGGESTED_FIELD_MAP)) {
    const hit = candidates.find((c) => names.includes(c))
      || names.find((n) => candidates.some((c) => n.toLowerCase() === c.toLowerCase()));
    if (hit) mapping[field] = hit;
  }
  return mapping;
}

/**
 * Turn Notion SDK / network errors into a UI-friendly payload.
 * Never throw raw stack traces to the browser.
 */
export function formatNotionError(err, { label } = {}) {
  const name = label || 'Notion';
  const title = `Couldn't reach ${name}`;
  let message = err?.message || String(err);
  let code = err?.code || undefined;
  let status = err?.status || undefined;
  let body = undefined;
  if (isNotionClientError(err)) {
    code = err.code;
    status = err.status;
    body = err.body;
    message = err.message;
  } else if (err?.body) {
    body = typeof err.body === 'string' ? err.body : JSON.stringify(err.body);
  }
  let details = message;
  if (code) details = `[${code}] ${details}`;
  if (status) details = `HTTP ${status} ${details}`;
  if (body && typeof body === 'string' && body.length && body !== message) {
    details = `${details}\n${body.slice(0, 2000)}`;
  }
  return { title, message, details, code, status };
}

/** Extract a bare UUID (with or without dashes) from a Notion URL or pasted id. */
export function parseNotionId(input) {
  if (!input) return null;
  const raw = String(input).trim();
  // collection://uuid
  const coll = raw.match(/^collection:\/\/([0-9a-f-]{32,36})$/i);
  if (coll) return normalizeUuid(coll[1]);
  // Bare uuid
  const bare = raw.match(/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i);
  if (bare) return normalizeUuid(bare[0]);
  // URL with 32-hex id (notion.so / app.notion.com)
  const fromUrl = raw.match(/([0-9a-f]{32})/i) || raw.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  if (fromUrl) return normalizeUuid(fromUrl[1]);
  return null;
}

function normalizeUuid(id) {
  const hex = String(id).replace(/-/g, '').toLowerCase();
  if (hex.length !== 32) return id;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function summarizeDataSource(ds, parentDatabase) {
  const dsTitle = richTextPlain(ds.title) || ds.name || 'Untitled data source';
  const dbTitle = parentDatabase
    ? (richTextPlain(parentDatabase.title) || parentDatabase.name || 'Untitled database')
    : (ds.parent?.type === 'database_id' ? null : null);
  const parentTitle = dbTitle
    || (typeof ds.database_parent?.title !== 'undefined' ? richTextPlain(ds.database_parent.title) : null);
  const label = parentTitle && parentTitle !== dsTitle
    ? `${parentTitle} · ${dsTitle}`
    : (parentTitle || dsTitle);
  return {
    id: ds.id,
    dataSourceId: ds.id,
    title: dsTitle,
    name: dsTitle,
    label,
    databaseId: parentDatabase?.id || ds.parent?.database_id || null,
    databaseTitle: parentTitle || null,
    url: ds.url || parentDatabase?.url || null,
    lastEdited: ds.last_edited_time,
    object: 'data_source',
  };
}

/**
 * List data sources the integration can see (API 2025-09-03+ search filter).
 * Display label = parent database title · data source name when they differ.
 */
export async function listDataSources(client) {
  const out = [];
  let cursor;
  do {
    const res = await client.search({
      filter: { property: 'object', value: 'data_source', in_trash: false },
      start_cursor: cursor,
      page_size: 50,
    });
    for (const item of res.results || []) {
      if (item.object !== 'data_source') continue;
      let parentDb = null;
      const dbId = item.parent?.database_id;
      if (dbId) {
        try {
          parentDb = await client.databases.retrieve({ database_id: dbId });
        } catch {
          parentDb = null;
        }
      }
      // Prefer full retrieve for title when search returns a partial
      let ds = item;
      if (!item.title || !item.properties) {
        try {
          ds = await client.dataSources.retrieve({ data_source_id: item.id });
        } catch {
          ds = item;
        }
      }
      out.push(summarizeDataSource(ds, parentDb));
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

/** @deprecated Use listDataSources — kept as alias for older callers/tests. */
export async function listDatabases(client) {
  return listDataSources(client);
}

/**
 * Resolve a pasted database URL/ID or data source ID into one or more data sources.
 * - data_source id → single choice
 * - database id → databases.retrieve → data_sources[]; auto-pick if one
 */
export async function resolveToDataSources(client, input) {
  const id = parseNotionId(input);
  if (!id) {
    return { status: 'invalid', error: 'Paste a Notion database URL or ID', choices: [] };
  }

  // Try as data source first
  try {
    const ds = await client.dataSources.retrieve({ data_source_id: id });
    let parentDb = null;
    if (ds.parent?.database_id) {
      try {
        parentDb = await client.databases.retrieve({ database_id: ds.parent.database_id });
      } catch { /* ignore */ }
    }
    const choice = summarizeDataSource(ds, parentDb);
    return { status: 'ok', choices: [choice], selected: choice };
  } catch {
    // not a data source — fall through to database
  }

  try {
    const db = await client.databases.retrieve({ database_id: id });
    const refs = db.data_sources || [];
    if (!refs.length) {
      return {
        status: 'empty',
        error: 'That database has no data sources the integration can see',
        choices: [],
        database: { id: db.id, title: richTextPlain(db.title) || 'Untitled database', url: db.url },
      };
    }
    const choices = [];
    for (const ref of refs) {
      let ds;
      try {
        ds = await client.dataSources.retrieve({ data_source_id: ref.id });
      } catch {
        ds = { id: ref.id, object: 'data_source', title: [{ plain_text: ref.name || 'Data source' }], name: ref.name, parent: { database_id: db.id } };
      }
      choices.push(summarizeDataSource(ds, db));
    }
    if (choices.length === 1) {
      return { status: 'ok', choices, selected: choices[0], database: { id: db.id, title: richTextPlain(db.title) || 'Untitled', url: db.url } };
    }
    return {
      status: 'choose',
      choices,
      selected: null,
      database: { id: db.id, title: richTextPlain(db.title) || 'Untitled', url: db.url },
      error: 'This database has several data sources — pick one',
    };
  } catch (err) {
    return {
      status: 'error',
      error: formatNotionError(err, { label: 'Notion' }).message,
      details: formatNotionError(err, { label: 'Notion' }),
      choices: [],
    };
  }
}

export async function getDataSourceSchema(client, dataSourceId) {
  const ds = await client.dataSources.retrieve({ data_source_id: dataSourceId });
  const properties = {};
  for (const [name, prop] of Object.entries(ds.properties || {})) {
    properties[name] = {
      id: prop.id,
      type: prop.type,
      options: prop.type === 'select' || prop.type === 'status' || prop.type === 'multi_select'
        ? (prop[prop.type]?.options || []).map((o) => ({ id: o.id, name: o.name, color: o.color }))
        : undefined,
    };
  }
  let databaseTitle = null;
  let databaseId = ds.parent?.database_id || null;
  if (databaseId) {
    try {
      const db = await client.databases.retrieve({ database_id: databaseId });
      databaseTitle = richTextPlain(db.title) || null;
    } catch { /* ignore */ }
  }
  const title = richTextPlain(ds.title) || 'Untitled';
  const label = databaseTitle && databaseTitle !== title ? `${databaseTitle} · ${title}` : (databaseTitle || title);
  return {
    id: ds.id,
    dataSourceId: ds.id,
    databaseId,
    title,
    label,
    databaseTitle,
    url: ds.url,
    properties,
    suggestedMapping: suggestMapping(properties),
  };
}

/** @deprecated Prefer getDataSourceSchema — resolves database→data source when needed. */
export async function getDatabaseSchema(client, databaseOrDataSourceId) {
  const resolved = await resolveToDataSources(client, databaseOrDataSourceId);
  if (resolved.selected) {
    return getDataSourceSchema(client, resolved.selected.dataSourceId);
  }
  if (resolved.choices?.length === 1) {
    return getDataSourceSchema(client, resolved.choices[0].dataSourceId);
  }
  if (resolved.status === 'choose') {
    const err = new Error(resolved.error || 'Pick a data source');
    err.code = 'data_source_choice_required';
    err.choices = resolved.choices;
    throw err;
  }
  throw new Error(resolved.error || 'Could not resolve data source');
}

export async function fetchDataSourceRows(client, dataSourceId, { pageSize = 50 } = {}) {
  const rows = [];
  let cursor;
  do {
    const res = await client.dataSources.query({
      data_source_id: dataSourceId,
      start_cursor: cursor,
      page_size: pageSize,
    });
    for (const page of res.results || []) {
      rows.push(page);
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return rows;
}

/** @deprecated Use fetchDataSourceRows */
export async function fetchDatabaseRows(client, databaseOrDataSourceId, opts) {
  // If caller already has a data source id, query directly; else resolve.
  try {
    return await fetchDataSourceRows(client, databaseOrDataSourceId, opts);
  } catch {
    const resolved = await resolveToDataSources(client, databaseOrDataSourceId);
    if (!resolved.selected) throw new Error(resolved.error || 'Pick a data source first');
    return fetchDataSourceRows(client, resolved.selected.dataSourceId, opts);
  }
}

export function pageToIdea(page, mapping = loadSettings().notion?.mapping || {}) {
  const props = page.properties || {};
  const get = (field) => readProperty(props[mapping[field] || field]);
  return {
    notionPageId: page.id,
    notionLastEdited: page.last_edited_time,
    url: page.url,
    title: get('title') || richTextPlain(page.properties?.title) || 'Untitled',
    stage: get('stage') || '',
    persona: get('persona') || '',
    leaveBehind: get('leave_behind') || '',
    link: get('link') || '',
    targetWeek: get('target_week') || '',
    raw: Object.fromEntries(
      Object.entries(props).map(([k, v]) => [k, readProperty(v)]),
    ),
  };
}

export function readProperty(prop) {
  if (!prop) return '';
  switch (prop.type) {
    case 'title':
    case 'rich_text':
      return richTextPlain(prop[prop.type]);
    case 'select':
    case 'status':
      return prop[prop.type]?.name || '';
    case 'multi_select':
      return (prop.multi_select || []).map((o) => o.name).join(', ');
    case 'url':
      return prop.url || '';
    case 'date':
      return prop.date?.start || '';
    case 'number':
      return prop.number ?? '';
    case 'checkbox':
      return !!prop.checkbox;
    case 'people':
      return (prop.people || []).map((p) => p.name || p.id).join(', ');
    default:
      return '';
  }
}

export function richTextPlain(arr) {
  if (!arr) return '';
  if (typeof arr === 'string') return arr;
  return (arr || []).map((t) => t.plain_text || '').join('');
}

/**
 * Build Notion property update payload from app fields + mapping + schema types.
 */
export function buildPropertyUpdates(fields, mapping, schemaProps) {
  const props = {};
  for (const [field, value] of Object.entries(fields)) {
    const name = mapping[field];
    if (!name || !schemaProps[name]) continue;
    const type = schemaProps[name].type;
    props[name] = encodeProperty(type, value);
  }
  return props;
}

export function encodeProperty(type, value) {
  const text = value == null ? '' : String(value);
  switch (type) {
    case 'title':
      return { title: [{ type: 'text', text: { content: text.slice(0, 2000) } }] };
    case 'text':
    case 'rich_text':
      return { rich_text: [{ type: 'text', text: { content: text.slice(0, 2000) } }] };
    case 'select':
      return text ? { select: { name: text } } : { select: null };
    case 'status':
      return text ? { status: { name: text } } : { status: null };
    case 'multi_select':
      return {
        multi_select: text
          ? text.split(',').map((s) => s.trim()).filter(Boolean).map((name) => ({ name }))
          : [],
      };
    case 'url':
      return { url: text || null };
    case 'date':
      return text ? { date: { start: text } } : { date: null };
    case 'number':
      return { number: text === '' ? null : Number(text) };
    case 'checkbox':
      return { checkbox: !!value && value !== 'false' && value !== '0' };
    default:
      return { rich_text: [{ type: 'text', text: { content: text.slice(0, 2000) } }] };
  }
}

/**
 * Conflict if remote last_edited_time is newer than the stamp we last synced,
 * and remote content differs from what we intend to write.
 */
export function detectConflict({ localStamp, remoteStamp, localFields, remoteIdea, mapping }) {
  if (!localStamp || !remoteStamp) return { conflict: false };
  if (new Date(remoteStamp).getTime() <= new Date(localStamp).getTime()) {
    return { conflict: false };
  }
  const diffs = [];
  for (const field of Object.keys(mapping || {})) {
    const localVal = normalize(localFields[field]);
    const remoteKey = {
      title: 'title',
      stage: 'stage',
      persona: 'persona',
      leave_behind: 'leaveBehind',
      link: 'link',
      target_week: 'targetWeek',
    }[field] || field;
    const remoteVal = normalize(remoteIdea?.[remoteKey]);
    if (localVal !== remoteVal && localVal !== '') {
      diffs.push({ field, local: localVal, remote: remoteVal });
    }
  }
  return { conflict: diffs.length > 0, diffs, remoteStamp };
}

function normalize(v) {
  if (v == null) return '';
  return String(v).trim();
}

export async function updatePage(client, pageId, properties) {
  return client.pages.update({ page_id: pageId, properties });
}

export async function retrievePage(client, pageId) {
  return client.pages.retrieve({ page_id: pageId });
}

/** Create a page under a data source (API 2025-09-03+ parent shape). */
export async function createPageInDataSource(client, dataSourceId, properties) {
  return client.pages.create({
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties,
  });
}
