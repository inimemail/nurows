import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { dnsGuardOrder, moveDnsGuard } from '../shared/dns-guard-order.js';
import { normalizeOrchestrationState, orchestrationDefaults, registerOrchestrationRoutes } from '../server/orchestration.js';

const guards = ['a', 'hidden', 'b', 'c'].map(id => ({ id, name: id, cycle: { id: `cycle-${id}` }, currentValues: ['192.0.2.1'] }));
function fixture() {
  let state = { ...orchestrationDefaults(), dnsGuards: structuredClone(guards) };
  const routes = {};
  let writes = 0;
  registerOrchestrationRoutes(Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (path, handler) => { routes[`${method} ${path}`] = handler; }])), {
    readState: keys => Object.fromEntries(keys.map(key => [key, structuredClone(state[key])])),
    updateState: mutator => { writes++; state = mutator(structuredClone(state)); return state; },
    onDnsGuardChanged: () => { throw new Error('Sorting must not wake the scheduler'); }
  });
  return {
    call: (body, key = 'put /api/dns-guards/order', params = {}) => {
      const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; } };
      routes[key]({ body, params }, res);
      return res;
    },
    state: () => state, writes: () => writes
  };
}

test('legacy data preserves display order; stale and duplicate IDs are pruned, new tasks appended', () => {
  assert.deepEqual(dnsGuardOrder(guards), ['a', 'hidden', 'b', 'c']);
  const normalized = normalizeOrchestrationState({ dnsGuards: guards, dnsGuardOrder: ['c', 'deleted', 'c', 'a'] });
  assert.deepEqual(normalized.dnsGuardOrder, ['c', 'a', 'hidden', 'b']);
  assert.deepEqual(normalizeOrchestrationState(normalized).dnsGuardOrder, normalized.dnsGuardOrder);
});

test('relative moves in a filtered list preserve hidden/new tasks and running checks', () => {
  const f = fixture();
  const res = f.call({ id: 'c', targetId: 'a', placement: 'before' });
  assert.deepEqual(res.data, { dnsGuardOrder: ['c', 'a', 'hidden', 'b'] });
  assert.deepEqual(f.state().dnsGuards, guards);
  assert.equal(f.writes(), 1);
  assert.deepEqual(f.call({}, 'get /api/orchestration/status/:section', { section: 'guards' }).data.dnsGuardOrder, res.data.dnsGuardOrder);
  // Repeated drops and adjacent no-ops do not write the database.
  f.call({ id: 'c', targetId: 'a', placement: 'before' });
  f.call({ id: 'a', targetId: 'a', placement: 'after' });
  assert.equal(f.writes(), 1);
  assert.deepEqual(f.call({ id: 'a', targetId: 'b', placement: 'after' }).data.dnsGuardOrder, ['c', 'hidden', 'b', 'a']);
});

test('bad inputs/deleted targets never modify state', () => {
  const f = fixture();
  for (const body of [null, {}, { id: [], targetId: 'b', placement: 'before' }, { id: 'a', targetId: 'b', placement: 'middle' }]) assert.equal(f.call(body).code, 400);
  assert.equal(f.call({ id: 'gone', targetId: 'a', placement: 'before' }).code, 404);
  assert.equal(f.writes(), 0);
  assert.deepEqual(moveDnsGuard(['a', 'b'], 'a', 'gone', 'after'), ['a', 'b']);
});

test('production order storage projects only IDs, keeps all runtime objects, and publishes only after a successful write', () => {
  const source = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const start = source.indexOf('function readDnsGuardOrderState()');
  const end = source.indexOf('function updateRenewalState', start);
  assert.ok(start > 0 && end > start);
  let cachedState = { ...orchestrationDefaults(), dnsGuards: structuredClone(guards), ipAssets: [{ id: 'asset' }] };
  const initial = cachedState;
  let writes = 0, fail = false;
  const context = {
    ensureStorage() {}, STORAGE_KEYS: { state: 'state' },
    get cachedState() { return cachedState; }, set cachedState(value) { cachedState = value; },
    dbSetJson(key, next) { assert.equal(key, 'state'); writes++; if (fail) throw Error('disk full'); assert.equal(cachedState, initial); assert.deepEqual(next.dnsGuardOrder, ['c', 'a', 'hidden', 'b']); }
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const snapshot = context.readDnsGuardOrderState();
  assert.deepEqual(Array.from(snapshot.dnsGuards, guard => Object.keys(guard)), guards.map(() => ['id']));
  snapshot.dnsGuards[0].id = 'changed';
  assert.equal(cachedState.dnsGuards[0].id, 'a');
  fail = true;
  assert.throws(() => context.updateDnsGuardOrderState(draft => { draft.dnsGuardOrder = ['c', 'a', 'hidden', 'b']; }), /disk full/);
  assert.equal(cachedState, initial);
  fail = false;
  context.updateDnsGuardOrderState(draft => { draft.dnsGuardOrder = ['c', 'a', 'hidden', 'b']; });
  assert.notEqual(cachedState, initial);
  assert.equal(cachedState.dnsGuards, initial.dnsGuards);
  assert.equal(cachedState.ipAssets, initial.ipAssets);
  assert.equal(writes, 2);
});

test('sorting uses lightweight projection and writer without reading full state or inventory', () => {
  let order = [], writes = 0;
  const routes = {};
  registerOrchestrationRoutes(Object.fromEntries(['get', 'post', 'put', 'delete'].map(method => [method, (path, handler) => { routes[`${method} ${path}`] = handler; }])), {
    readState() { assert.fail('must not clone runtime state'); }, updateState() { assert.fail('must not scan pools'); },
    readDnsGuardOrderState: () => ({ dnsGuards: guards.map(({ id }) => ({ id })), dnsGuardOrder: order }),
    updateDnsGuardOrderState: fn => { const draft = { dnsGuards: guards.map(({ id }) => ({ id })), dnsGuardOrder: order }; fn(draft); order = draft.dnsGuardOrder; writes++; }
  });
  let result;
  const res = { json: value => { result = value; } };
  const req = { body: { id: 'c', targetId: 'a', placement: 'before' } };
  routes['put /api/dns-guards/order'](req, res);
  routes['put /api/dns-guards/order'](req, res);
  assert.equal(writes, 1);
  assert.deepEqual(result.dnsGuardOrder, ['c', 'a', 'hidden', 'b']);
});
