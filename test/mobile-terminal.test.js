import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { canAutoFocusTerminal, isTerminalSubmitKey, terminalCopyText } from '../src/terminal-interaction.js';
import { trackMobileViewport } from '../src/mobile-viewport.js';

const source = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
function between(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
function senderHarness({ mode = 'command-job', ready = true, connected = true } = {}) {
  const requests = [], writes = [], notices = [];
  let input = 'echo test', focused = 0, busy = false;
  const context = vm.createContext({
    mode, ready, session: { jobId: 'job', serverId: 'server' },
    socketRef: { current: { send: (data) => writes.push(JSON.parse(data)) } },
    manualInputSendingRef: { current: false }, mountedRef: { current: true },
    canWriteToSocket: () => connected, applyInputChunk: () => {},
    setManualInput: (value) => { input = typeof value === 'function' ? value(input) : value; },
    setManualInputBusy: (value) => { busy = value; }, setTerminalNotice: (value) => notices.push(value),
    terminalRef: { current: { focus: () => focused++, writeln() {} } }, canAutoFocusTerminal: () => false,
    api: (_url, options) => new Promise((resolve, reject) => requests.push({ options, resolve, reject }))
  });
  vm.runInContext(between('  async function sendManualCommand(', '\n  function reconnectTerminal('), context);
  return { context, requests, writes, notices, send: context.sendManualCommand,
    input: () => input, edit: (value) => { input = value; }, busy: () => busy, focused: () => focused };
}

test('terminal input submits once while pending, clears only after delivery, and keeps phone input focus', async () => {
  const view = senderHarness();
  const first = view.send('echo test');
  await view.send('echo test');
  assert.equal(view.requests.length, 1);
  assert.equal(view.busy(), true);
  assert.equal(view.requests[0].options.timeoutMs, 15000);
  view.requests[0].resolve({ sent: 1 });
  await first;
  assert.equal(view.input(), '');
  assert.equal(view.busy(), false);
  assert.equal(view.focused(), 0);
});

test('undelivered or failed input remains editable and the sender can retry', async () => {
  for (const fail of [false, true]) {
    const view = senderHarness();
    const first = view.send('echo test');
    if (fail) view.requests[0].reject(new Error('发送超时'));
    else view.requests[0].resolve({ sent: 0 });
    await first;
    assert.equal(view.input(), 'echo test');
    assert.equal(view.busy(), false);
    assert.match(view.notices.at(-1), /未收到|超时/);
    const retry = view.send('echo test');
    view.requests[1].resolve({ sent: 1 });
    await retry;
    assert.equal(view.input(), '');
  }
});

test('typing a new command during delivery is preserved; enter-only and Ctrl+C never erase drafts', async () => {
  const view = senderHarness();
  const send = view.send('echo test');
  view.edit('next command');
  view.requests[0].resolve({ sent: 1 });
  await send;
  assert.equal(view.input(), 'next command');
  for (const [value, options, expected] of [
    ['', { appendEnter: true, clearInput: false }, { data: '', raw: false }],
    ['\u0003', { appendEnter: false }, { data: '\u0003', raw: true }]
  ]) {
    const pending = view.send(value, options);
    const request = view.requests.at(-1);
    const body = JSON.parse(request.options.body);
    assert.equal(body.data, expected.data);
    assert.equal(body.raw, expected.raw);
    request.resolve({ sent: 1 });
    await pending;
    assert.equal(view.input(), 'next command');
  }
});

test('SSH input requires an established connection and sends pasted multiline text only on submit', async () => {
  for (const ready of [true, false]) {
    const view = senderHarness({ mode: 'ssh', ready });
    view.edit('echo a\necho b');
    const first = view.send('echo a\necho b');
    await view.send('echo a\necho b');
    await first;
    assert.equal(view.writes.length, ready ? 1 : 0);
    assert.equal(view.requests.length, 0);
    assert.equal(view.input(), ready ? '' : 'echo a\necho b');
    if (ready) assert.equal(view.writes[0].data, 'echo a\necho b\r');
  }
});

test('composition confirmation and Shift+Enter do not execute terminal commands', () => {
  assert.equal(isTerminalSubmitKey({ key: 'Enter' }), true);
  for (const event of [{ key: 'Enter', isComposing: true }, { key: 'Enter', nativeEvent: { isComposing: true } },
    { key: 'Enter', keyCode: 229 }, { key: 'Enter', shiftKey: true }, { key: 'a' }]) {
    assert.equal(isTerminalSubmitKey(event), false);
  }
});

test('terminal automatic focus respects phone keyboards, active forms, and foreground dialogs', () => {
  const doc = { querySelector: () => null, activeElement: { matches: () => false } };
  const win = { matchMedia: () => ({ matches: false }) };
  assert.equal(canAutoFocusTerminal(doc, win), true);
  win.matchMedia = () => ({ matches: true });
  assert.equal(canAutoFocusTerminal(doc, win), false);
  win.matchMedia = () => ({ matches: false });
  doc.querySelector = () => ({});
  assert.equal(canAutoFocusTerminal(doc, win), false);
  doc.querySelector = () => null;
  doc.activeElement.matches = () => true;
  assert.equal(canAutoFocusTerminal(doc, win), false);
});

test('copying terminal output respects selection, wraps, current cursor, and bounded history', () => {
  let reads = 0;
  const terminal = { hasSelection: () => false, buffer: { active: {
    length: 20000, baseY: 19970, cursorY: 4,
    getLine: (index) => { reads++; return { isWrapped: index === 19974, translateToString: () => `${index}` }; }
  } } };
  assert.equal(terminalCopyText(terminal, 3), '19972\n1997319974');
  assert.equal(reads, 3);
  terminal.hasSelection = () => true;
  terminal.getSelection = () => 'selected';
  assert.equal(terminalCopyText(terminal), 'selected');
  assert.equal(reads, 3);
});

test('phone viewport updates are shared, frame-batched, safe for pinch zoom, and fully cleaned up', () => {
  const properties = new Map(), listeners = new Map(), frames = new Map();
  let nextFrame = 0;
  const surface = (prefix) => ({ addEventListener: (name, fn) => listeners.set(`${prefix}:${name}`, fn),
    removeEventListener: (name) => listeners.delete(`${prefix}:${name}`) });
  const viewport = { ...surface('viewport'), height: 400, offsetTop: 50, scale: 1 };
  const media = { ...surface('media'), matches: true };
  const win = { ...surface('window'), visualViewport: viewport, innerHeight: 800, matchMedia: () => media,
    requestAnimationFrame: (fn) => { frames.set(++nextFrame, fn); return nextFrame; }, cancelAnimationFrame: (id) => frames.delete(id) };
  const doc = { documentElement: { style: { setProperty: (name, value) => properties.set(name, value), removeProperty: (name) => properties.delete(name) } } };
  const cleanup = trackMobileViewport(win, doc);
  assert.equal(properties.get('--mobile-viewport-height'), '400px');
  assert.equal(properties.get('--mobile-viewport-top'), '50px');
  assert.equal(properties.get('--mobile-viewport-bottom'), '350px');
  for (let i = 0; i < 50; i++) listeners.get('viewport:scroll')();
  assert.equal(frames.size, 1);
  viewport.height = 500;
  const runFrame = () => { const fn = [...frames.values()][0]; frames.clear(); fn(); };
  runFrame();
  assert.equal(properties.get('--mobile-viewport-height'), '500px');
  viewport.scale = 2;
  listeners.get('viewport:resize')(); runFrame();
  assert.equal(properties.size, 0);
  viewport.scale = 1; media.matches = false;
  listeners.get('media:change')(); runFrame();
  assert.equal(properties.size, 0);
  listeners.get('window:resize')();
  cleanup();
  assert.equal(listeners.size, 0);
  assert.equal(frames.size, 0);
  assert.equal(properties.size, 0);
});

test('send timeout aborts the request, retains a useful delivery warning, and releases resources', async () => {
  let callback, cleared = 0, signal;
  const context = vm.createContext({ AbortController,
    window: { setTimeout: (fn) => { callback = fn; return 1; }, clearTimeout: () => cleared++ },
    fetch: (_url, options) => { signal = options.signal; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))); }
  });
  vm.runInContext(between('async function api(', '\nfunction SearchIcon('), context);
  const request = context.api('/input', { timeoutMs: 15000 });
  callback();
  await assert.rejects(request, /请先确认服务器是否收到/);
  assert.equal(signal.aborted, true);
  assert.equal(cleared, 1);
});

test('clipboard paste is staged without executing, with a native paste dialog when read access is denied', async () => {
  for (const allowed of [true, false]) {
    const inserted = [], dialogs = [];
    const context = vm.createContext({ navigator: { clipboard: { readText: async () => {
      if (!allowed) throw new Error('denied');
      return 'echo a\necho b';
    } } }, clipboardReturnFocusRef: { current: null }, clipboardOperationRef: { current: 0 },
    mountedRef: { current: true }, visibleRef: { current: true },
    insertManualText: (value) => inserted.push(value), setTerminalNotice() {},
    setClipboardDialog: (value) => dialogs.push(value),
    api() { assert.fail('paste must not execute'); }, socketRef: { current: { send() { assert.fail('paste must not execute'); } } } });
    vm.runInContext(between('  async function pasteTerminalText(', '\n  async function copyTerminalText('), context);
    await context.pasteTerminalText();
    assert.equal(inserted.length, allowed ? 1 : 0);
    if (allowed) assert.equal(inserted[0], 'echo a\necho b');
    else { assert.equal(dialogs[0].type, 'paste'); assert.equal(dialogs[0].value, ''); }
  }
});

test('clipboard permission returning after switching sessions cannot insert into a hidden terminal', async () => {
  let resolve;
  const context = vm.createContext({ navigator: { clipboard: { readText: () => new Promise((done) => { resolve = done; }) } },
    clipboardReturnFocusRef: { current: null }, clipboardOperationRef: { current: 0 },
    mountedRef: { current: true }, visibleRef: { current: true },
    insertManualText() { assert.fail('hidden terminal changed'); }, setTerminalNotice() {}, setClipboardDialog() { assert.fail('hidden terminal opened a dialog'); } });
  vm.runInContext(between('  async function pasteTerminalText(', '\n  async function copyTerminalText('), context);
  const paste = context.pasteTerminalText();
  context.visibleRef.current = false;
  resolve('command');
  await paste;
});

test('successful sends remove their timeout; normal authenticated requests retain the supplied cancellation signal', async () => {
  for (const timeoutMs of [undefined, 15000]) {
    const external = new AbortController();
    let cleared = 0, options, unauthorized = 0;
    const context = vm.createContext({ AbortController,
      window: { setTimeout: () => 1, clearTimeout: () => cleared++ },
      fetch: async (_url, supplied) => { options = supplied; return { ok: true, json: async () => ({ sent: 1 }) }; }
    });
    vm.runInContext(between('async function api(', '\nfunction SearchIcon('), context);
    const data = await context.api('/input', { timeoutMs, signal: external.signal });
    assert.equal(data.sent, 1);
    assert.equal(cleared, timeoutMs ? 1 : 0);
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.timeoutMs, undefined);
    if (!timeoutMs) assert.equal(options.signal, external.signal);
    context.fetch = async () => ({ ok: false, status: 401, json: async () => ({ error: 'login required' }) });
    await assert.rejects(context.api('/input', { onUnauthorized: () => unauthorized++ }), /login required/);
    assert.equal(unauthorized, 1);
  }
});

test('late clipboard copy results cannot reopen closed dialogs or replace a newer clipboard operation', async () => {
  for (const action of ['hide', 'close', 'new-operation']) {
    for (const success of [true, false]) {
      let resolve, reject;
      const dialogs = [], notices = [];
      const context = vm.createContext({
        clipboardOperationRef: { current: 0 }, mountedRef: { current: true }, visibleRef: { current: true },
        copyNoteText: () => new Promise((done, fail) => { resolve = done; reject = fail; }),
        setClipboardDialog: (value) => dialogs.push(value), setTerminalNotice: (value) => notices.push(value)
      });
      vm.runInContext(between('  async function copyTerminalText(', '\n  function openTerminalCopy('), context);
      const pending = context.copyTerminalText('output');
      if (action === 'hide') context.visibleRef.current = false;
      else if (action === 'close') context.closeTerminalClipboard();
      else context.clipboardOperationRef.current++;
      const previousCount = dialogs.length;
      if (success) resolve(); else reject(new Error('copy denied'));
      await pending;
      assert.equal(dialogs.length, previousCount);
      assert.equal(notices.length, 0);
    }
  }
});

test('cancelling while an input response body is loading cannot be reported as success', async () => {
  for (const timeoutMs of [undefined, 15000]) {
    const external = new AbortController();
    let signal;
    let bodyReady;
    const loadingBody = new Promise((resolve) => { bodyReady = resolve; });
    const context = vm.createContext({ AbortController,
      window: { setTimeout: () => 1, clearTimeout() {} },
      fetch: async (_url, options) => {
        signal = options.signal;
        return { ok: true, json: () => new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('response cancelled')));
          bodyReady();
        }) };
      }
    });
    vm.runInContext(between('async function api(', '\nfunction SearchIcon('), context);
    const pending = context.api('/input', { timeoutMs, signal: external.signal });
    await loadingBody;
    external.abort();
    await assert.rejects(pending, /response cancelled/);
    assert.equal(signal.aborted, true);
  }
});

test('per-server send dialogs retain input unless every requested server received it', async () => {
  for (const automation of [false, true]) {
    for (const sent of [0, 1, 2]) {
      let closed = 0;
      const notices = [], marked = [];
      const context = vm.createContext({
        batchInputSendingRef: { current: false }, automationInputSendingRef: { current: false },
        commandInputEpochRef: { current: 0 }, batchInputValueRef: { current: 'a\nb' },
        batchInputReady: true, commandJobId: 'job', automationJobId: 'job',
        batchInputDialog: { awaitingServerIds: ['s1', 's2'] },
        automationInputDialog: { awaitingServerIds: ['s1', 's2'] }, automationInputLines: ['a', 'b'],
        parsePerServerInputLines: () => ['a', 'b'], setActionBusy() {},
        api: async () => ({ sent }), toast: (value) => notices.push(value),
        closeBatchInputDialog: () => closed++, closeAutomationInputDialog: () => closed++,
        markInputSent: (ids) => marked.push(ids)
      });
      const start = automation ? '  async function submitAutomationPerServerInput(' : '  async function submitPerServerInput(';
      const end = automation ? '\n  function openEditor(' : '\n  function saveInteractiveKeywords(';
      vm.runInContext(between(start, end), context);
      await (automation ? context.submitAutomationPerServerInput() : context.submitPerServerInput());
      assert.equal(closed, sent === 2 ? 1 : 0);
      assert.equal(marked.length, !automation && sent === 2 ? 1 : 0);
      if (sent === 1) assert.match(notices.at(-1), /避免重复发送/);
      assert.equal(context.batchInputSendingRef.current, false);
      assert.equal(context.automationInputSendingRef.current, false);
    }
  }
});
