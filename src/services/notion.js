import { Client } from '@notionhq/client';
import { loadSettings } from '../config.js';

export function createNotionClient(token) {
  if (!token) throw new Error('Notion token not configured');
  return new Client({ auth: token });
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

export async function listDatabases(client) {
  const out = [];
  let cursor;
  do {
    const res = await client.search({
      filter: { property: 'object', value: 'database' },
      start_cursor: cursor,
      page_size: 50,
    });
    for (const db of res.results || []) {
      out.push({
        id: db.id,
        title: richTextPlain(db.title) || 'Untitled database',
        url: db.url,
        lastEdited: db.last_edited_time,
      });
    }
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

export async function getDatabaseSchema(client, databaseId) {
  const db = await client.databases.retrieve({ database_id: databaseId });
  const properties = {};
  for (const [name, prop] of Object.entries(db.properties || {})) {
    properties[name] = {
      id: prop.id,
      type: prop.type,
      options: prop.type === 'select' || prop.type === 'status' || prop.type === 'multi_select'
        ? (prop[prop.type]?.options || []).map((o) => ({ id: o.id, name: o.name, color: o.color }))
        : undefined,
    };
  }
  return {
    id: db.id,
    title: richTextPlain(db.title) || 'Untitled',
    url: db.url,
    properties,
    suggestedMapping: suggestMapping(properties),
  };
}

export async function fetchDatabaseRows(client, databaseId, { pageSize = 50 } = {}) {
  const rows = [];
  let cursor;
  do {
    const res = await client.databases.query({
      database_id: databaseId,
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
