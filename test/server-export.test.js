import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { registerServerExportRoutes } from '../server/server-export.js';
import { serverExportText, tokenizeServerImportRow } from '../shared/server-export.js';

const fixture = () => ({ groups: [{ id: 'g', name: '香港 "A" 组' }, { id: 'other', name: '其他' }], servers: [
  { id: 'a', groupId: 'g', name: '第一台', host: '192.0.2.1', port: 22, username: 'root', passwordEnc: 'encrypted-a' },
  { id: 'b', groupId: 'g', name: 'v6 节点', host: '2001:db8::1', port: 2222, username: 'admin', passwordEnc: 'encrypted-b' },
  { id: 'outside', groupId: 'other', name: '不导出', host: '192.0.2.3' }
] });
function harness() {
  const state = fixture();
  let handler, decrypts = 0;
  registerServerExportRoutes({ post(path, callback) { assert.equal(path, '/api/groups/:id/export'); handler = callback; } }, {
    readState: () => state,
    passwordFor(server, key) { assert.equal(key, 'session-key'); decrypts++; return server.id === 'a' ? 'pass "both\'" \\ ,|\n换行' : ''; }
  });
  return { state, decrypts: () => decrypts, request(body, id = 'g') {
    const response = { statusCode: 200, headers: {} };
    handler({ body, params: { id }, auth: { encryptionKey: 'session-key' } }, {
      status(code) { response.statusCode = code; return this; }, set(key, value) { response.headers[key] = value; }, json(value) { response.body = value; }
    });
    return response;
  } };
}

test('group export includes only selected members in group order, decrypts passwords and never modifies state', () => {
  const h = harness(), before = structuredClone(h.state);
  const result = h.request({ mode: 'import', serverIds: ['b', 'a', 'a'] });
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.body.count, 2);
  assert.equal(h.decrypts(), 2);
  const rows = result.body.text.split('\n').map(tokenizeServerImportRow);
  assert.deepEqual(rows[0], ['第一台', '192.0.2.1', '22', 'root', 'pass "both\'" \\ ,|\n换行', '香港 "A" 组']);
  assert.deepEqual(rows[1], ['v6 节点', '2001:db8::1', '2222', 'admin', '', '香港 "A" 组']);
  assert.deepEqual(h.state, before);
  assert.ok(!result.body.text.includes('encrypted-'));
});

test('IP mode exports one address per line and never reads any password', () => {
  const h = harness();
  const result = h.request({ mode: 'ip', serverIds: ['a', 'b'] });
  assert.equal(result.body.text, '192.0.2.1\n2001:db8::1');
  assert.equal(h.decrypts(), 0);
});

test('export rejects malformed selection and moved, deleted or other-group servers before revealing passwords', () => {
  const h = harness();
  for (const body of [null, {}, { mode: 'invalid', serverIds: ['a'] }, { mode: 'import', serverIds: [] }, { mode: 'ip', serverIds: [null] }]) {
    assert.equal(h.request(body).statusCode, 400);
  }
  for (const id of ['outside', 'deleted']) assert.equal(h.request({ mode: 'import', serverIds: ['a', id] }).statusCode, 409);
  h.state.servers[0].groupId = 'other';
  assert.equal(h.request({ mode: 'import', serverIds: ['a'] }).statusCode, 409);
  assert.equal(h.request({ mode: 'ip', serverIds: ['b'] }, 'missing').statusCode, 404);
  assert.equal(h.decrypts(), 0);
});

test('exported rows round-trip through the actual importer including empty passwords, both quotes and escapes', () => {
  const source = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const context = vm.createContext({ tokenizeServerImportRow, uuidv4: () => 'imported' });
  vm.runInContext(source.slice(source.indexOf('function parseImportText('), source.indexOf('function buildConnectOptions(')), context);
  const servers = fixture().servers.slice(0, 2);
  const password = ' $() `text` "双引号" \'单引号\' \\ \t\n ';
  const text = serverExportText(servers, '分组 "A" \'B\'', 'import', server => server.id === 'a' ? password : '');
  const imported = context.parseImportText(text);
  assert.equal(imported.length, 2);
  assert.equal(imported[0].password, password);
  assert.equal(imported[1].password, '');
  assert.equal(imported[1].host, '2001:db8::1');
  assert.equal(imported[1].groupName, '分组 "A" \'B\'');
  const legacy = context.parseImportText('"legacy node"|192.0.2.1|22|root|\'with spaces\'|default')[0];
  assert.equal(legacy.name, 'legacy node');
  assert.equal(legacy.password, 'with spaces');
  assert.equal(legacy.groupName, 'default');
});
