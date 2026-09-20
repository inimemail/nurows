import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const app = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
function between(source, start, end) {
  const index = source.indexOf(start);
  assert.notEqual(index, -1);
  const last = source.indexOf(end, index + start.length);
  assert.notEqual(last, -1);
  return source.slice(index, last);
}

test('temporary command survives template selection and edits; saving as a template starts a separate draft', () => {
  let drawerClosed = 0;
  const ctx = vm.createContext({ selectedCommandId: '', commandText: '', temporaryCommandText: '',
    EMPTY_COMMAND: { id: '', name: '', command: '' },
    closeAssetDrawerOnMobile() { drawerClosed++; }
  });
  for (const [setter, field] of Object.entries({ setSelectedCommandId: 'selectedCommandId', setCommandText: 'commandText', setTemporaryCommandText: 'temporaryCommandText', setCommandDraft: 'commandDraft', setEditorDialog: 'editorDialog' })) {
    ctx[setter] = (value) => { ctx[field] = value; };
  }
  vm.runInContext(between(app, '  function selectCommand(', '  async function saveCommand('), ctx);
  ctx.updateCommandText('df -h');
  ctx.selectCommand({ id: 'template', command: 'uptime' });
  ctx.updateCommandText('uptime && free -m');
  assert.equal(ctx.temporaryCommandText, 'df -h');
  ctx.selectCommand();
  assert.equal(ctx.selectedCommandId, '');
  assert.equal(ctx.commandText, 'df -h');
  assert.equal(drawerClosed, 2);
  ctx.saveTemporaryCommandAsTemplate();
  assert.equal(ctx.commandDraft.id, '');
  assert.equal(ctx.commandDraft.command, 'df -h');
  assert.equal(ctx.editorDialog.mode, 'create');
  ctx.commandDraft.command = 'another command';
  assert.equal(ctx.temporaryCommandText, 'df -h');
  ctx.updateCommandText('');
  ctx.selectCommand({ id: 'template', command: 'uptime' });
  ctx.selectCommand();
  assert.equal(ctx.commandText, '');
});

test('temporary selection cannot fall through to deleting all saved templates', () => {
  let confirmations = 0;
  const ctx = vm.createContext({ selectedCommandId: '', state: { commands: [{ id: 'saved' }] },
    toast() {}, openConfirm() { confirmations++; }, removeCommand() {} });
  vm.runInContext(between(app, '  function confirmSidebarDelete(', '  async function saveGroup('), ctx);
  ctx.confirmSidebarDelete('command');
  assert.equal(confirmations, 0);
  ctx.selectedCommandId = 'saved';
  ctx.confirmSidebarDelete('command');
  assert.equal(confirmations, 1);
});

test('temporary draft round-trips independently of a selected template and migrates legacy freeform text', () => {
  const ctx = vm.createContext({ sanitizeInteractiveKeywords: () => [], normalizeTerminalSessions: () => [] });
  vm.runInContext(between(server, 'function getWorkspaceForUser(', 'function createCommandJob('), ctx);
  vm.runInContext(between(app, 'function normalizeWorkspacePayload(', 'export default function App('), ctx);
  const cases = [
    [{ selectedCommandId: 'saved', commandText: 'uptime', temporaryCommandText: 'df -h' }, 'df -h'],
    [{ selectedCommandId: 'saved', commandText: 'uptime', temporaryCommandText: '' }, ''],
    [{ selectedCommandId: '', commandText: 'legacy freeform' }, 'legacy freeform'],
    [{ selectedCommandId: 'saved', commandText: 'uptime' }, ''],
    [{ commandText: 123, temporaryCommandText: {} }, ''],
    [{}, '']
  ];
  for (const [input, expected] of cases) {
    const persisted = ctx.normalizeWorkspaceInput(input);
    const returned = ctx.getWorkspaceForUser({ workspaces: { tester: persisted } }, { username: 'tester' });
    const restored = ctx.normalizeWorkspacePayload(returned);
    assert.equal(restored.temporaryCommandText, expected);
    assert.equal(ctx.normalizeWorkspacePayload(input).temporaryCommandText, expected);
  }
});

test('command execution accepts temporary text with no saved templates and uses the normal job pipeline', async () => {
  let handler, executed;
  const jobs = new Map();
  const state = { commands: [], servers: [{ id: 'host' }], proxies: [] };
  const ctx = vm.createContext({ app: { post(_path, callback) { handler = callback; } }, readState: () => state,
    commandJobs: jobs,
    createCommandJob(servers, command, keywords) { return { id: 'job', command, interactiveKeywords: keywords, results: servers.map((item) => ({ serverId: item.id })) }; },
    runInteractiveCommandJob(job) { executed = job; }
  });
  vm.runInContext(between(server, "app.post('/api/commands/execute',", "app.get('/api/commands/jobs/:id',"), ctx);
  let response;
  await handler({ body: { serverIds: ['host'], commandId: '', commandText: '  df -h  ' }, auth: {} }, { json(value) { response = value; } });
  assert.equal(response.command, 'df -h');
  assert.equal(response.results[0].serverId, 'host');
  assert.equal(jobs.get('job'), executed);
  assert.equal(state.commands.length, 0);
});
