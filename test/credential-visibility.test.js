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

test('pool alerts require a configured bot and protect its delivery settings', async () => {
  const harness = createHarness(credentialState());
  const poolBody = {
    name: '备用池', assetIds: [], allocationMode: 'one', allocationCount: 1, selectionMode: 'ordered',
    enabled: true, alertEnabled: true, alertThresholds: [5, 1, 0], alertBotIds: []
  };
  await assert.rejects(
    harness.request('POST', '/api/orchestration/:resource', { params: { resource: 'ip-pools' }, body: poolBody }),
    /至少选择一个发送机器人/
  );

  const created = await harness.request('POST', '/api/orchestration/:resource', {
    params: { resource: 'ip-pools' }, body: { ...poolBody, alertBotIds: ['bot-1'] }
  });
  assert.equal(created.statusCode, 200);
  await assert.rejects(
    harness.request('PUT', '/api/orchestration/:resource/:id', {
      params: { resource: 'telegram-bots', id: 'bot-1' },
      body: { name: '运维机器人', enabled: true, userIds: [], menuScopes: [], automationTaskIds: [] }
    }),
    /请先解除备用池关联/
  );
  await assert.rejects(
    harness.request('DELETE', '/api/orchestration/:resource/:id', { params: { resource: 'telegram-bots', id: 'bot-1' } }),
    /仍被其他配置引用/
  );
});

test('deletes one idle incident and bulk-clears records while preserving running work', async () => {
  const state = credentialState();
  state.incidents = [
    { id: 'waiting', targetName: '等待项', status: 'waiting_for_ip', executionId: '' },
    { id: 'done', targetName: '完成项', status: 'succeeded', executionId: '' },
    { id: 'stabilizing', targetName: '等待 DNS', status: 'stabilizing', executionId: '' },
    { id: 'running', targetName: '运行项', status: 'automating', executionId: 'execution-1' }
  ];
  state.ipLeases = [
    { id: 'waiting-lease', incidentId: 'waiting' },
    { id: 'stabilizing-lease', incidentId: 'stabilizing' },
    { id: 'running-lease', incidentId: 'running' }
  ];
  const harness = createHarness(state);

  const single = await harness.request('DELETE', '/api/incidents/:id', { params: { id: 'waiting' } });
  assert.equal(single.body.removed, true);
  assert.deepEqual(harness.readState().incidents.map((item) => item.id), ['done', 'stabilizing', 'running']);
  assert.deepEqual(harness.readState().ipLeases.map((item) => item.id), ['stabilizing-lease', 'running-lease']);

  await assert.rejects(
    harness.request('DELETE', '/api/incidents/:id', { params: { id: 'stabilizing' } }),
    /事件正在执行/
  );

  const all = await harness.request('DELETE', '/api/incidents');
  assert.equal(all.body.removed, 1);
  assert.equal(all.body.kept, 2);
  assert.deepEqual(harness.readState().incidents.map((item) => item.id), ['stabilizing', 'running']);
});
