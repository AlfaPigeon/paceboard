import test from 'node:test';
import assert from 'node:assert/strict';
import {
  suggestMapping,
  pageToIdea,
  buildPropertyUpdates,
  detectConflict,
  encodeProperty,
  readProperty,
} from '../src/services/notion.js';

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

test('mock Notion client import path via pageToIdea mapping', async () => {
  // Lightweight fake client used the same way routes would.
  const pages = [
    {
      id: 'p1',
      url: 'https://n/p1',
      last_edited_time: '2026-11-03T00:00:00.000Z',
      properties: {
        Video: { type: 'title', title: [{ plain_text: 'One' }] },
        Stage: { type: 'select', select: { name: 'Draft' } },
      },
    },
  ];
  const client = {
    async databases() {},
  };
  client.databases.query = async () => ({ results: pages, has_more: false });
  const mapping = { title: 'Video', stage: 'Stage' };
  const ideas = (await client.databases.query({})).results.map((p) => pageToIdea(p, mapping));
  assert.equal(ideas[0].title, 'One');
});
