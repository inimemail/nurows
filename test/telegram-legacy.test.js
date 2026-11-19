import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { telegramScopeAllowed } from '../shared/telegram-permissions.js';

const source = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const legacy = source.slice(source.indexOf('function telegramButtons('), source.indexOf('\nasync function sendTelegramMenu('));

function harness() {
  const bot = { id: 'b', enabled: true, menuScopeVersion: 2, menuScopes: ['automation', 'assets'], automationTaskIds: ['t'], role: 'operator' };
  const state = { telegramBots: [bot], automationTasks: [{ id: 't', name: '任务' }], automationRuns: [], probes: [] };
  const pending = new Map(), packets = [], jobs = [];
  const context = vm.createContext({
    readState: () => state, telegramRuntime: { pending }, telegramWorkspace: { handle: async () => false },
    telegramAuthorized: (settings) => settings?.enabled, telegramMenuAllowed: telegramScopeAllowed,
    telegramCanOperate: (_state, settings) => settings.role === 'operator',
    telegramPendingIsFresh: (value) => value.expiresAt > Date.now(),
    telegramCancelButtons: () => ({ inline_keyboard: [] }),
    telegramPermissionDenied: () => packets.push({ text: 'denied' }),
    telegramCall: async (_token, method, body) => { packets.push({ method, ...body }); return { message_id: 20 }; },
    startAutomationTask: (...args) => { jobs.push(args); return { id: 'j', results: [], concurrency: 1 }; },
    scheduleTelegramProgress() {}
  });
  vm.runInContext(legacy, context);
  const setPending = () => pending.set('b:10:1', { taskId: 't', hosts: ['192.0.2.1'], confirmMessageId: 20, expiresAt: Date.now() + 60000 });
  const click = (data, messageId = 20) => context.handleTelegramUpdate({ callback_query: { id: 'c', from: { id: 1 }, message: { chat: { id: 10 }, message_id: messageId }, data } }, 'token', bot);
  const send = text => context.handleTelegramUpdate({ message: { from: { id: 1 }, chat: { id: 10 }, text } }, 'token', bot);
  return { bot, state, pending, packets, jobs, context, setPending, click, send };
}

test('legacy automation confirmation is message-bound and single-use', async () => {
  const h = harness(); h.setPending();
  await h.click('confirm:yes', 19); assert.equal(h.jobs.length, 0);
  await h.click('confirm:yes'); assert.equal(h.jobs.length, 1);
  await h.click('confirm:yes'); assert.equal(h.jobs.length, 1);
  assert.equal(h.pending.size, 0);
});

test('legacy automation rechecks task allowlist, scope and role before execution', async () => {
  for (const revoke of [(bot) => { bot.automationTaskIds = []; }, (bot) => { bot.menuScopes = []; }, (bot) => { bot.role = 'viewer'; }]) {
    const h = harness(); h.setPending(); revoke(h.bot);
    await h.click('confirm:yes'); assert.equal(h.jobs.length, 0);
    assert.equal(h.packets.at(-1).text, 'denied');
  }
});

test('legacy confirmation refreshes permissions after Telegram acknowledgement', async () => {
  const h = harness(); h.setPending();
  const call = h.context.telegramCall;
  h.context.telegramCall = async (...args) => {
    if (args[1] === 'answerCallbackQuery') h.bot.menuScopes = [];
    return call(...args);
  };
  await h.click('confirm:yes'); assert.equal(h.jobs.length, 0);
  assert.equal(h.packets.at(-1).text, 'denied');
});

test('legacy sessions cannot cross bots or execute expired confirmations', async () => {
  const h = harness(); h.setPending();
  h.pending.set('other:10:1', h.pending.get('b:10:1')); h.pending.delete('b:10:1');
  await h.click('confirm:yes'); assert.equal(h.jobs.length, 0);
  h.setPending(); h.pending.get('b:10:1').expiresAt = 1;
  await h.click('confirm:yes'); assert.equal(h.jobs.length, 0);
});

test('Telegram pool creation requires explicit valid probe selection before IP input', async () => {
  const h = harness();
  h.bot.menuScopes = ['pools'];
  await h.click('pool_create:new');
  await h.send('IPv6 备用池');
  assert.match(h.packets.at(-1).text, /先在网页添加有效探针/);
  h.state.probes.push({ id: 'v6', name: 'IPv6 探针' }, { id: 'v4', name: 'IPv4 探针' });
  await h.send('IPv6 备用池');
  assert.equal(h.pending.get('b:10:1').action, 'pool_create_probes');
  assert.match(h.packets.at(-1).text, /1. IPv6 探针/);
  await h.send('3');
  assert.equal(h.pending.get('b:10:1').action, 'pool_create_probes');
  h.state.probes[0].enabled = false;
  await h.send('1');
  assert.equal(h.pending.get('b:10:1').action, 'pool_create_probes');
  h.state.probes[0].enabled = true;
  await h.send('1');
  assert.equal(h.pending.get('b:10:1').action, 'pool_create_ips');
  assert.deepEqual(Array.from(h.pending.get('b:10:1').probeIds), ['v6']);
  assert.match(h.packets.at(-1).text, /请发送初始 IP/);
});
