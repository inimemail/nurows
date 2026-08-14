import assert from 'node:assert/strict';
import test from 'node:test';
import {
  orchestrationDefaults,
  registerOrchestrationRoutes,
  sanitizeOrchestrationState
} from '../server/orchestration.js';

function encryptSecret(value) {
  return Buffer.from(String(value)).toString('base64url');
}

function decryptSecret(value) {
  return Buffer.from(String(value), 'base64url').toString();
}

function createHarness(initialState) {
  let state = structuredClone(initialState);
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) => [method, (path, handler) => routes.set(`${method.toUpperCase()} ${path}`, handler)]));
  const deps = {
    readState: () => state,
    updateState: (updater) => { state = updater(state); return state; },
    sanitizeState: (next) => sanitizeOrchestrationState(next),
    encryptSecret,
    decryptSecret
  };
  registerOrchestrationRoutes(app, deps);
  return {
    readState: () => state,
    request: async (method, route, { params = {}, body = {} } = {}) => {
      const handler = routes.get(`${method} ${route}`);
      assert.ok(handler, `route is registered: ${method} ${route}`);
      const response = { statusCode: 200, headers: new Map(), body: null };
      const res = {
        status(code) { response.statusCode = code; return this; },
        set(name, value) { response.headers.set(String(name).toLowerCase(), String(value)); return this; },
        json(value) { response.body = value; return this; }
      };
      await handler({ params, body, auth: { username: 'tester' } }, res, (error) => { if (error) throw error; });
      return response;
    }
  };
}

function credentialState() {
  return {
    ...orchestrationDefaults(),
    automationTasks: [],
    dnsAccounts: [{
      id: 'dns-1',
      name: '华为云',
      provider: 'huawei',
      enabled: true,
      credentialsEnc: encryptSecret(JSON.stringify({ accessKey: 'saved-ak', secretKey: 'saved-sk' })),
      status: 'healthy',
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z'
    }],
    telegramBots: [{
      id: 'bot-1',
      name: '运维机器人',
      enabled: true,
      tokenEnc: encryptSecret('123456:telegram-token'),
      tokenHash: 'private-hash',
      userIds: ['10001'],
      roles: {},
      menuScopes: [],
      automationTaskIds: [],
      createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:00:00.000Z'
    }]
  };
}

test('sanitized state never exposes encrypted credentials or token hashes', () => {
  const sanitized = sanitizeOrchestrationState(credentialState());
  assert.equal(sanitized.dnsAccounts[0].configured, true);
  assert.equal(sanitized.telegramBots[0].configured, true);
  assert.equal('credentialsEnc' in sanitized.dnsAccounts[0], false);
  assert.equal('tokenEnc' in sanitized.telegramBots[0], false);
  assert.equal('tokenHash' in sanitized.telegramBots[0], false);
});

test('credential reveal endpoints return saved values without caching and write audits', async () => {
  const harness = createHarness(credentialState());
  const dnsResponse = await harness.request('GET', '/api/dns-accounts/:id/credentials', { params: { id: 'dns-1' } });
  assert.equal(dnsResponse.statusCode, 200);
  assert.equal(dnsResponse.headers.get('cache-control'), 'no-store');
  assert.deepEqual(dnsResponse.body.credentials, { accessKey: 'saved-ak', secretKey: 'saved-sk' });

  const botResponse = await harness.request('GET', '/api/telegram-bots/:id/token', { params: { id: 'bot-1' } });
  assert.equal(botResponse.statusCode, 200);
  assert.equal(botResponse.headers.get('cache-control'), 'no-store');
  assert.equal(botResponse.body.token, '123456:telegram-token');
  assert.deepEqual(harness.readState().auditLogs.slice(0, 2).map((item) => item.action), [
    'telegram_bot.reveal',
    'dns_account.reveal'
  ]);
});

test('editing one DNS credential keeps the other saved fields', async () => {
  const harness = createHarness(credentialState());
  const response = await harness.request('PUT', '/api/orchestration/:resource/:id', {
    params: { resource: 'dns-accounts', id: 'dns-1' },
    body: {
        name: '华为云',
        provider: 'huawei',
        enabled: true,
        credentials: { accessKey: 'changed-ak' }
    }
  });
  assert.equal(response.statusCode, 200);
  const saved = JSON.parse(decryptSecret(harness.readState().dnsAccounts[0].credentialsEnc));
  assert.deepEqual(saved, { accessKey: 'changed-ak', secretKey: 'saved-sk' });
});
