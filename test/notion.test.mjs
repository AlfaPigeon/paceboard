import test from 'node:test';
import assert from 'node:assert/strict';
import {
  suggestMapping,
  pageToIdea,
  buildPropertyUpdates,
  detectConflict,
  encodeProperty,
  readProperty,
  parseNotionId,
  resolveToDataSources,
  fetchDataSourceRows,
  listDataSources,
  getDataSourceSchema,
  formatNotionError,
  createNotionClient,
  NOTION_VERSION,
  createPageInDataSource,
} from '../src/services/notion.js';
import { Client } from '@notionhq/client';

test('pins Notion-Version 2025-09-03 (data_source model)', () => {
  assert.equal(NOTION_VERSION, '2025-09-03');
  const client = createNotionClient('secret_test_token_xxxxxx');
  assert.ok(client instanceof Client);
  // SDK default matches; we pin explicitly so bumps cannot drift
  assert.equal(Client.defaultNotionVersion, '2025-09-03');
});

test('suggestMapping fits Video-pipeline-like schemas', () => {
  const properties = {
    Video: { type: 'title' },
    Stage: { type: 'select' },
    Persona: { type: 'multi_select' },
    'Leave-behind': { type: 'rich_text' },
    Link: { type: 'url' },
    'Target week': { type: 'date' },
    Place: { type: 'rich_text' },
  };
  const mapping = suggestMapping(properties);
  assert.deepEqual(mapping, {
    title: 'Video',
    stage: 'Stage',
    persona: 'Persona',
    leave_behind: 'Leave-behind',
    link: 'Link',
    target_week: 'Target week',
  });
});

test('pageToIdea + encode/read property round-trip shapes', () => {
  const mapping = {
    title: 'Video',
    stage: 'Stage',
    persona: 'Persona',
    leave_behind: 'Leave-behind',
    link: 'Link',
    target_week: 'Target week',
  };
  const page = {
    id: 'page-1',
    url: 'https://notion.so/page-1',
    last_edited_time: '2026-11-01T12:00:00.000Z',
    properties: {
      Video: { type: 'title', title: [{ plain_text: 'Ship the harness' }] },
      Stage: { type: 'select', select: { name: 'Draft' } },
      Persona: { type: 'multi_select', multi_select: [{ name: 'builder' }, { name: 'agent' }] },
      'Leave-behind': { type: 'rich_text', rich_text: [{ plain_text: 'You can build this' }] },
      Link: { type: 'url', url: 'https://example.com' },
      'Target week': { type: 'date', date: { start: '2026-11-10' } },
    },
  };
  const idea = pageToIdea(page, mapping);
  assert.equal(idea.title, 'Ship the harness');
  assert.equal(idea.stage, 'Draft');
  assert.equal(idea.persona, 'builder, agent');
  assert.equal(idea.leaveBehind, 'You can build this');
  assert.equal(idea.link, 'https://example.com');
  assert.equal(idea.targetWeek, '2026-11-10');

  const schemaProps = {
    Video: { type: 'title' },
    Stage: { type: 'select' },
    Persona: { type: 'multi_select' },
    'Leave-behind': { type: 'rich_text' },
    Link: { type: 'url' },
    'Target week': { type: 'date' },
  };
  const props = buildPropertyUpdates({
    title: 'Ship the harness',
    stage: 'Publish',
    persona: 'builder, agent',
    leave_behind: 'You can build this',
    link: 'https://example.com',
    target_week: '2026-11-10',
  }, mapping, schemaProps);
  assert.equal(props.Stage.select.name, 'Publish');
  assert.equal(props.Video.title[0].text.content, 'Ship the harness');
  assert.equal(props.Link.url, 'https://example.com');
  assert.equal(encodeProperty('checkbox', true).checkbox, true);
  assert.equal(encodeProperty('text', 'hi').rich_text[0].text.content, 'hi');
  assert.equal(readProperty({ type: 'number', number: 3 }), 3);
});

test('detectConflict uses last_edited_time and field diffs', () => {
  const mapping = { title: 'Video', stage: 'Stage' };
  const none = detectConflict({
    localStamp: '2026-11-02T10:00:00.000Z',
    remoteStamp: '2026-11-02T09:00:00.000Z',
    localFields: { title: 'A', stage: 'Draft' },
    remoteIdea: { title: 'A', stage: 'Draft' },
    mapping,
  });
  assert.equal(none.conflict, false);

  const conflict = detectConflict({
    localStamp: '2026-11-02T10:00:00.000Z',
    remoteStamp: '2026-11-02T11:00:00.000Z',
    localFields: { title: 'Local title', stage: 'Draft' },
    remoteIdea: { title: 'Remote title', stage: 'Draft' },
    mapping,
  });
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.diffs[0].field, 'title');
});

test('parseNotionId accepts URLs, bare UUIDs, and collection://', () => {
  assert.equal(
    parseNotionId('0843e2aa53064b27a0fe6fb32e191fd6'),
    '0843e2aa-5306-4b27-a0fe-6fb32e191fd6',
  );
  assert.equal(
    parseNotionId('https://www.notion.so/workspace/0843e2aa53064b27a0fe6fb32e191fd6?v=abc'),
    '0843e2aa-5306-4b27-a0fe-6fb32e191fd6',
  );
  assert.equal(
    parseNotionId('collection://3c7490f3-967e-4a47-9ff6-a429e97a647c'),
    '3c7490f3-967e-4a47-9ff6-a429e97a647c',
  );
  assert.equal(parseNotionId('not-an-id'), null);
});

test('formatNotionError titles with database name and falls back to Notion', () => {
  const withLabel = formatNotionError(new Error('boom'), { label: 'Video pipeline' });
  assert.equal(withLabel.title, "Couldn't reach Video pipeline");
  assert.match(withLabel.details, /boom/);

  const fallback = formatNotionError(new Error('offline'));
  assert.equal(fallback.title, "Couldn't reach Notion");
});

test('listDataSources searches filter value data_source with in_trash false', async () => {
  const calls = [];
  const client = {
    async search(body) {
      calls.push(body);
      return {
        results: [{
          object: 'data_source',
          id: '3c7490f3-967e-4a47-9ff6-a429e97a647c',
          title: [{ plain_text: 'Video pipeline' }],
          parent: { type: 'database_id', database_id: '0843e2aa-5306-4b27-a0fe-6fb32e191fd6' },
          last_edited_time: '2026-11-03T00:00:00.000Z',
          properties: { Video: { type: 'title' } },
        }],
        has_more: false,
      };
    },
    databases: {
      async retrieve({ database_id }) {
        assert.equal(database_id, '0843e2aa-5306-4b27-a0fe-6fb32e191fd6');
        return {
          id: database_id,
          title: [{ plain_text: 'Video pipeline' }],
          data_sources: [{ id: '3c7490f3-967e-4a47-9ff6-a429e97a647c', name: 'Video pipeline' }],
        };
      },
    },
    dataSources: {
      async retrieve() { throw new Error('should not retrieve when title+props present'); },
    },
  };
  const list = await listDataSources(client);
  assert.equal(calls[0].filter.value, 'data_source');
  assert.equal(calls[0].filter.in_trash, false);
  assert.notEqual(calls[0].filter.value, 'database');
  assert.equal(list.length, 1);
  assert.equal(list[0].dataSourceId, '3c7490f3-967e-4a47-9ff6-a429e97a647c');
  assert.equal(list[0].databaseId, '0843e2aa-5306-4b27-a0fe-6fb32e191fd6');
});

test('URL → database with one data_source auto-selects', async () => {
  const dbId = '0843e2aa-5306-4b27-a0fe-6fb32e191fd6';
  const dsId = '3c7490f3-967e-4a47-9ff6-a429e97a647c';
  const client = {
    dataSources: {
      async retrieve() {
        const err = new Error('not a data source');
        err.status = 404;
        throw err;
      },
    },
    databases: {
      async retrieve({ database_id }) {
        assert.equal(database_id, dbId);
        return {
          id: dbId,
          title: [{ plain_text: 'Video pipeline' }],
          url: `https://notion.so/${dbId.replace(/-/g, '')}`,
          data_sources: [{ id: dsId, name: 'Video pipeline' }],
        };
      },
    },
  };
  // Second retrieve for the DS after database resolve
  client.dataSources.retrieve = async ({ data_source_id }) => {
    if (data_source_id === dsId) {
      return {
        object: 'data_source',
        id: dsId,
        title: [{ plain_text: 'Video pipeline' }],
        parent: { type: 'database_id', database_id: dbId },
        properties: {
          Video: { id: 'title', type: 'title' },
          Stage: { id: 'stage', type: 'select', select: { options: [{ name: 'Draft' }] } },
        },
      };
    }
    const err = new Error('not found');
    err.status = 404;
    throw err;
  };

  const result = await resolveToDataSources(
    client,
    `https://www.notion.so/workspace/${dbId.replace(/-/g, '')}`,
  );
  assert.equal(result.status, 'ok');
  assert.equal(result.selected.dataSourceId, dsId);
  assert.equal(result.choices.length, 1);
});

test('URL → database with N data_sources requires choose', async () => {
  const dbId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const client = {
    dataSources: {
      async retrieve({ data_source_id }) {
        if (data_source_id === dbId) {
          const err = new Error('not a ds');
          err.status = 404;
          throw err;
        }
        return {
          object: 'data_source',
          id: data_source_id,
          title: [{ plain_text: data_source_id === 'ds-1' ? 'Main' : 'Archive' }],
          parent: { type: 'database_id', database_id: dbId },
          properties: {},
        };
      },
    },
    databases: {
      async retrieve() {
        return {
          id: dbId,
          title: [{ plain_text: 'Multi DS DB' }],
          data_sources: [
            { id: 'ds-1', name: 'Main' },
            { id: 'ds-2', name: 'Archive' },
          ],
        };
      },
    },
  };
  const result = await resolveToDataSources(client, dbId);
  assert.equal(result.status, 'choose');
  assert.equal(result.choices.length, 2);
  assert.equal(result.selected, null);
});

test('fetchDataSourceRows uses dataSources.query not databases.query', async () => {
  const pages = [{
    id: 'p1',
    url: 'https://n/p1',
    last_edited_time: '2026-11-03T00:00:00.000Z',
    properties: {
      Video: { type: 'title', title: [{ plain_text: 'One' }] },
      Stage: { type: 'select', select: { name: 'Draft' } },
    },
  }];
  let queried = null;
  const client = {
    dataSources: {
      async query(body) {
        queried = body;
        return { results: pages, has_more: false };
      },
    },
    databases: {
      async query() {
        throw new Error('databases.query must not be called on data_source model');
      },
    },
  };
  const rows = await fetchDataSourceRows(client, '3c7490f3-967e-4a47-9ff6-a429e97a647c');
  assert.equal(queried.data_source_id, '3c7490f3-967e-4a47-9ff6-a429e97a647c');
  assert.equal(rows[0].id, 'p1');
  const ideas = rows.map((p) => pageToIdea(p, { title: 'Video', stage: 'Stage' }));
  assert.equal(ideas[0].title, 'One');
});

test('getDataSourceSchema + createPage parent is data_source_id', async () => {
  const dsId = '3c7490f3-967e-4a47-9ff6-a429e97a647c';
  const dbId = '0843e2aa-5306-4b27-a0fe-6fb32e191fd6';
  const client = {
    dataSources: {
      async retrieve({ data_source_id }) {
        assert.equal(data_source_id, dsId);
        return {
          id: dsId,
          title: [{ plain_text: 'Video pipeline' }],
          parent: { type: 'database_id', database_id: dbId },
          properties: {
            Video: { id: 't', type: 'title' },
            Stage: { id: 's', type: 'select', select: { options: [{ id: '1', name: 'Draft', color: 'gray' }] } },
            'Leave-behind': { id: 'l', type: 'rich_text' },
          },
        };
      },
    },
    databases: {
      async retrieve({ database_id }) {
        return { id: database_id, title: [{ plain_text: 'Video pipeline' }] };
      },
    },
    pages: {
      async create(body) {
        return body;
      },
    },
  };
  const schema = await getDataSourceSchema(client, dsId);
  assert.equal(schema.dataSourceId, dsId);
  assert.equal(schema.suggestedMapping.title, 'Video');
  assert.equal(schema.suggestedMapping.stage, 'Stage');

  const created = await createPageInDataSource(client, dsId, {
    Video: { title: [{ type: 'text', text: { content: 'New' } }] },
  });
  assert.equal(created.parent.type, 'data_source_id');
  assert.equal(created.parent.data_source_id, dsId);
});
