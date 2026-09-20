import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
function harness() {
  let state = {
    groups: [{ id: 'group-default', name: '默认分组' }, { id: 'other', name: '其他' }],
    servers: [
      { id: 'a', groupId: 'group-default' },
      { id: 'hidden', groupId: 'group-default' },
      { id: 'new', groupId: 'group-default' },
      { id: 'moved', groupId: 'other' }
    ],
    commands: [{ id: 'command' }]
  };
  let handler, writes = 0;
  const start = source.indexOf("app.delete('/api/groups/:id/servers'");
  const end = source.indexOf("app.delete('/api/groups/:id',", start);
  vm.runInNewContext(source.slice(start, end), {
    app: { delete(_path, callback) { handler = callback; } },
    updateState(mutate) { const next = mutate(structuredClone(state)); writes++; state = next; return state; },
    sanitizeStateForClient: () => ({ sanitized: true })
  });
  return {
    state: () => state,
    writes: () => writes,
    request(body, id = 'group-default') {
      const response = { statusCode: 200, body: null };
      handler({ body, params: { id }, auth: { username: 'test' } }, {
        status(code) { response.statusCode = code; return this; },
        json(value) { response.body = value; return this; }
      });
      return response;
    }
  };
}

test('group clear uses one write, preserves groups and excludes newly added or moved servers', () => {
  const h = harness();
  const before = structuredClone(h.state());
  const body = { confirm: 'clear-group-servers', serverIds: ['a', 'hidden', 'a', 'moved', 'missing'] };
  const result = h.request(body);
  assert.equal(result.body.deletedCount, 2);
  assert.equal(result.body.state.sanitized, true);
  assert.equal(h.writes(), 1);
  assert.deepEqual(h.state().groups, before.groups);
  assert.deepEqual(h.state().commands, before.commands);
  assert.deepEqual(h.state().servers.map((item) => item.id), ['new', 'moved']);
  assert.equal(h.request(body).body.deletedCount, 0);
});

test('group clear rejects missing confirmation, invalid IDs and unknown groups without writes', () => {
  const h = harness();
  for (const body of [undefined, {}, { serverIds: ['a'] }, ...[undefined, [], 'a', [''], [null]].map((serverIds) => ({ confirm: 'clear-group-servers', serverIds }))]) {
    assert.equal(h.request(body).statusCode, 400);
  }
  assert.throws(() => h.request({ confirm: 'clear-group-servers', serverIds: ['a'] }, 'missing'), /未找到分组/);
  assert.equal(h.writes(), 0);
  assert.equal(h.state().servers.length, 4);
});

test('confirmation includes hidden group members and snapshots only this group; cancel does not delete', () => {
  const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  const start = app.indexOf('  function confirmClearGroup(');
  const end = app.indexOf('  async function clearGroupServers(', start);
  const state = harness().state();
  let dialog, deletion;
  const busy = {};
  const context = vm.createContext({ state, busy,
    openConfirm(value) { dialog = value; },
    clearGroupServers(groupId, ids) { deletion = { groupId, ids }; }
  });
  vm.runInContext(app.slice(start, end), context);
  context.confirmClearGroup(state.groups[0]);
  assert.match(dialog.message, /3 台服务器/);
  assert.match(dialog.message, /分组将保留/);
  assert.equal(deletion, undefined);
  state.servers.push({ id: 'later', groupId: 'group-default' });
  dialog.onConfirm();
  assert.equal(deletion.groupId, 'group-default');
  assert.deepEqual(deletion.ids, ['a', 'hidden', 'new']);
  dialog = null;
  busy.clearGroupServers = true;
  context.confirmClearGroup(state.groups[0]);
  assert.equal(dialog, null);
  busy.clearGroupServers = false;
  state.servers = [];
  context.confirmClearGroup(state.groups[0]);
  assert.equal(dialog, null);
});
