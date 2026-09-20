import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import vm from 'node:vm';
import { createSessionSocketRegistry, createWebSocketUpgradeHandler, isAllowedWebSocketOrigin } from '../server/websocket-security.js';

const source = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
function runtime(names, globals = {}) {
  const code = names.map((name) => { const start = source.indexOf(`function ${name}(`); assert.ok(start >= 0); return source.slice(start, source.indexOf('\n}\n', start) + 2); }).join('\n');
  const context = vm.createContext({ URL, Date, ...globals });
  vm.runInContext(code, context);
  return context;
}
function socket() {
  const ws = new EventEmitter();
  Object.assign(ws, { readyState: 1, OPEN: 1, sent: [], send(data) { this.sent.push(data); }, terminate() { this.readyState = 3; this.emit('close'); } });
  return ws;
}
const request = (headers = {}) => ({ url: '/ws/terminal', socket: {}, headers: { host: 'panel.example', origin: 'https://panel.example', 'x-forwarded-proto': 'https', ...headers } });

test('origin validation accepts direct and proxied same origin, rejects foreign, null, missing, and forged forwarded host', () => {
  assert.equal(isAllowedWebSocketOrigin(request()), true);
  assert.equal(isAllowedWebSocketOrigin(request({ origin: 'http://panel.example', 'x-forwarded-proto': '' })), true);
  for (const origin of [undefined, 'null', 'https://foreign.example', 'http://panel.example', 'https://panel.example:444', 'https://panel.example/path', 'file:///tmp/test']) {
    assert.equal(isAllowedWebSocketOrigin(request({ origin, 'x-forwarded-host': 'foreign.example' })), false, String(origin));
  }
  assert.equal(isAllowedWebSocketOrigin(request({ origin: 'https://public.example' }), { allowedOrigins: ['https://public.example'] }), true);
  assert.equal(isAllowedWebSocketOrigin(request({ origin: 'http://localhost:5173' })), false);
  assert.equal(isAllowedWebSocketOrigin(request({ origin: 'http://localhost:5173' }), { production: false, devPort: '5173' }), true);
});

test('malformed URL, cookie, or upgrade failure cannot escape the handshake handler', () => {
  const cookie = runtime(['getCookie']);
  assert.equal(cookie.getCookie('nurossh_session=%', 'nurossh_session'), '');
  const responses = [];
  const tcp = { write: (value) => responses.push(value), destroy() {} };
  const registry = { bind: () => true };
  for (const mode of ['badCookie', 'throwAuth', 'throwUpgrade', 'badUrl']) {
    const handler = createWebSocketUpgradeHandler({ sessionSockets: registry,
      getSession(req) { if (mode === 'throwAuth') throw Error('invalid auth'); return cookie.getCookie(req.headers.cookie, 'nurossh_session') ? {} : null; },
      wss: { handleUpgrade() { throw Error('invalid upgrade'); } } });
    const req = request({ cookie: mode === 'badCookie' ? 'nurossh_session=%' : 'nurossh_session=valid' });
    if (mode === 'badUrl') req.url = 'http://[';
    assert.doesNotThrow(() => handler(req, tcp, Buffer.alloc(0)));
    assert.match(responses.at(-1), /HTTP\/1.1 (400|401)/);
  }
});

test('session revocation between handshake and upgrade prevents a connection', () => {
  const session = { token: 'one', expiresAt: Date.now() + 60000 };
  const sessions = new Map([['one', session]]), registry = createSessionSocketRegistry(sessions);
  let complete, connected = false;
  const handler = createWebSocketUpgradeHandler({ sessionSockets: registry, getSession: () => session,
    wss: { handleUpgrade(_req, _socket, _head, cb) { complete = cb; }, emit() { connected = true; } } });
  handler(request(), { write() {}, destroy() {} }, Buffer.alloc(0));
  registry.revoke('one');
  const ws = socket(); complete(ws);
  assert.equal(connected, false);
  assert.equal(ws.readyState, 3);
});

test('logout revokes only that session; account changes revoke every existing session socket', () => {
  const sessions = new Map(['a', 'b'].map((token) => [token, { token, expiresAt: Date.now() + 60000 }]));
  const registry = createSessionSocketRegistry(sessions);
  const a = socket(), a2 = socket(), b = socket();
  registry.bind(a, sessions.get('a')); registry.bind(a2, sessions.get('a')); registry.bind(b, sessions.get('b'));
  registry.revoke('a');
  assert.equal(a.readyState, 3); assert.equal(a2.readyState, 3); assert.equal(registry.authorized(b), true);
  registry.revokeAll();
  assert.equal(b.readyState, 3); assert.equal(sessions.size, 0);
  assert.equal(registry.authorized(a), false);
});

test('expired sessions cannot exchange data, while a still-valid HTTP-refreshed session remains usable', () => {
  let now = 1000;
  const session = { token: 'a', expiresAt: 2000 }, sessions = new Map([['a', session]]);
  const registry = createSessionSocketRegistry(sessions, () => now), ws = socket();
  registry.bind(ws, session);
  now = 1900; session.expiresAt = 3000;
  assert.equal(registry.authorized(ws), true);
  now = 3000;
  assert.equal(registry.authorized(ws), false);
  assert.equal(ws.readyState, 3);
});

test('actual terminal and command-center handlers reject queued input and output after revocation', () => {
  const session = { token: 'a', expiresAt: Date.now() + 60000 }, sessions = new Map([['a', session]]);
  const sessionSockets = createSessionSocketRegistry(sessions);
  const terminal = socket(), command = socket();
  sessionSockets.bind(terminal, session); sessionSockets.bind(command, session);
  const inputs = [];
  const terminalRuntime = { clients: new Set(), shellStream: { write: (data) => inputs.push(data) } };
  const commandRuntime = { clients: new Set(), shellStream: {} };
  const job = { results: [{ serverId: 'server', stdout: '' }], sessions: new Map([['server', commandRuntime]]), pendingClients: new Map() };
  const context = runtime(['attachTerminalClient', 'handleCommandJobConnection', 'broadcastTerminalSession', 'broadcastCommandSession'], {
    sessionSockets, commandJobs: new Map([['job', job]]), writeCommandSessionInput: (_job, _rt, _item, data) => inputs.push(data),
    clearTimeout() {}, setTimeout: () => 1, TERMINAL_REATTACH_GRACE_MS: 1000
  });
  context.attachTerminalClient(terminalRuntime, terminal);
  context.handleCommandJobConnection(command, { url: '/ws/command-job?jobId=job&serverId=server' });
  terminal.emit('message', JSON.stringify({ type: 'input', data: 'before-terminal' }));
  command.emit('message', JSON.stringify({ type: 'input', data: 'before-command' }));
  assert.equal(inputs.length, 2);
  sessionSockets.revoke('a');
  terminal.emit('message', JSON.stringify({ type: 'input', data: 'after' }));
  command.emit('message', 'malformed raw input');
  assert.equal(inputs.length, 2);
  // Even a stale output queue cannot send through a revoked session.
  terminalRuntime.clients.add(terminal); terminal.readyState = terminal.OPEN;
  const before = terminal.sent.length;
  context.broadcastTerminalSession(terminalRuntime, { type: 'output', data: 'private' });
  assert.equal(terminal.sent.length, before);
  assert.ok(job.sessions.has('server'), 'background job is preserved');
});

test('logout and account change routes call session-wide socket revocation', () => {
  const handlers = new Map();
  let revoked, all = false;
  const context = vm.createContext({ app: { post: (path, handler) => handlers.set(path, handler) },
    getCookie: () => 'token', sessionSockets: { revoke: (token) => { revoked = token; }, revokeAll: () => { all = true; } },
    clearSessionCookie() {}, enforceAuthRateLimit() {}, readAuth: () => ({ username: 'user' }), verifyPassword: () => true,
    createAuthRecord: () => ({}), readState: () => ({}), writeAuth() {}, createSession: () => ({ token: 'new' }),
    deriveEncryptionKey() {}, setSessionCookie() {}, clearAuthRateLimit() {} });
  const start = source.indexOf("app.post('/api/auth/logout'");
  vm.runInContext(source.slice(start, source.indexOf("app.get('/api/state'", start)), context);
  handlers.get('/api/auth/logout')({ headers: {} }, { json() {} });
  assert.equal(revoked, 'token');
  handlers.get('/api/auth/account')({ body: { currentPassword: 'test', newPassword: 'changed' } }, { json() {} });
  assert.equal(all, true);
});
