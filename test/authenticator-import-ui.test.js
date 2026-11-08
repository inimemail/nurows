import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import * as authenticator from '../shared/authenticator.js';
import * as migration from '../shared/authenticator-migration.js';

const compiled = transformSync(fs.readFileSync(new URL('../src/AuthenticatorImportDialog.jsx', import.meta.url), 'utf8'), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const uri = `otpauth://totp/Example:alice?secret=${secret}&issuer=Example`;
function harness({ existing = [], read = async file => file.text, camera = async () => {}, request = async body => ({ imported: body.accounts.length, skipped: 0 }) } = {}) {
  const slots = [], effects = [], imports = [], calls = [];
  let cursor = 0, tree;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, value => { slots[i].value = typeof value === 'function' ? value(slots[i].value) : value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useMemo(fn) { return fn(); },
    useEffect(fn, deps) { const i = cursor++; if (!slots[i] || deps.some((value, n) => value !== slots[i].deps[n])) { slots[i]?.cleanup?.(); slots[i] = { deps }; effects.push(() => { slots[i].cleanup = fn(); }); } }
  };
  const jsx = (type, props) => ({ type, props }), module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, AbortController, Set, Error, require(name) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name === 'lucide-react') return new Proxy({}, { get: (_, name) => name });
    if (name.endsWith('/authenticator.js')) return authenticator;
    if (name.endsWith('authenticator-migration.js')) return migration;
    if (name.endsWith('authenticator-qr.js')) return { readAuthenticatorQr: read, scanAuthenticatorCamera: camera };
    throw Error(name);
  } });
  const props = { existing, Dialog: 'dialog', busy: false, error: '', request: async (path, body) => { calls.push([path, body]); return request(body); }, onClose() {}, onImported: result => imports.push(result) };
  const nodes = (value = tree) => Array.isArray(value) ? value.flatMap(nodes) : value && typeof value === 'object' ? [value, ...nodes(value.props?.children ?? null), ...nodes(value.props?.footer ?? null)] : [];
  const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '');
  const render = () => { cursor = 0; tree = module.exports.default(props); effects.splice(0).forEach(fn => fn()); return tree; };
  render();
  return { render, nodes, text: () => text(tree), calls, imports, button: label => nodes().find(node => node.type === 'button' && text(node).includes(label)),
    files: files => nodes().find(node => node.type === 'input' && node.props.type === 'file').props.onChange({ target: { files } }),
    unmount: () => slots.forEach(slot => slot.cleanup?.()) };
}

test('batch preview skips already saved keys and repeated files; double submit sends only one import', async () => {
  const h = harness(); await h.files([{ text: uri }, { text: uri }]); h.render();
  assert.equal(h.button('导入 1 个账号').props.disabled, false);
  const submit = h.button('导入 1 个账号').props.onClick;
  await Promise.all([submit(), submit()]);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], '/import-batch'); assert.equal(h.calls[0][1].accounts.length, 1);
  assert.equal(h.imports[0].imported, 1); h.unmount();
  const duplicate = harness({ existing: [{ secret }] }); await duplicate.files([{ text: uri }]); duplicate.render();
  assert.equal(duplicate.button('导入 0 个账号').props.disabled, true); assert.match(duplicate.text(), /已存在/); duplicate.unmount();
});

test('closing the importer aborts image work and ignores its late result', async () => {
  let finish, signal;
  const h = harness({ read: (_file, nextSignal) => { signal = nextSignal; return new Promise(resolve => { finish = resolve; }); } });
  const reading = h.files([{ text: uri }]); h.unmount(); assert.equal(signal.aborted, true);
  finish(uri); await reading; assert.equal(h.imports.length, 0); assert.equal(h.calls.length, 0);
});

test('closing camera scanning aborts its stream lifecycle and late callbacks do not add accounts', async () => {
  let signal, accept;
  const h = harness({ camera: async (_video, onText, _onError, nextSignal) => { signal = nextSignal; accept = onText; } });
  h.button('摄像头扫码').props.onClick(); h.render(); assert.equal(signal.aborted, false);
  h.unmount(); assert.equal(signal.aborted, true); accept(uri); assert.equal(h.calls.length, 0);
});

test('failed images remain visible even when a later image succeeds', async () => {
  const h = harness({ read: async file => { if (file.bad) throw Error('图片模糊'); return file.text; } });
  await h.files([{ bad: true }, { text: uri }]); h.render();
  assert.match(h.text(), /1 张未导入/); assert.equal(h.button('导入 1 个账号').props.disabled, false); h.unmount();
});

test('the preview explains account capacity before sending an oversized import', async () => {
  const h = harness({ existing: Array.from({ length: 500 }, (_, i) => ({ secret: `existing-${i}` })) });
  await h.files([{ text: uri }]); h.render();
  assert.match(h.text(), /还可添加 0 个/); assert.equal(h.button('导入 1 个账号').props.disabled, true);
  await h.button('导入 1 个账号').props.onClick(); assert.equal(h.calls.length, 0); h.unmount();
});


test('decoded migration format errors show the version without calling them image recognition failures', async () => {
  const payload = Buffer.from([16, 3]);
  const text = 'otpauth-migration://offline?data=' + encodeURIComponent(payload.toString('base64'));
  const h = harness(); await h.files([{ text }]); h.render();
  assert.match(h.text(), /二维码已识别，但未导入：暂不支持谷歌迁移格式版本 3/);
  assert.doesNotMatch(h.text(), /未成功识别/);
  assert.equal(h.button('导入 0 个账号').props.disabled, true);
  assert.equal(h.calls.length, 0); h.unmount();
});


test('image imports accept version-two and omitted-version payloads with default OTP fields', async () => {
  const field = (id, value) => { const bytes = Buffer.from(value); return Buffer.concat([Buffer.from([id * 8 + 2, bytes.length]), bytes]); };
  const account = field(1, Buffer.concat([field(1, '12345678901234567890'), field(2, 'Example:alice'), field(3, 'Example')]));
  for (const version of [null, 0, 1, 2]) {
    const payload = Buffer.concat([account, version === null ? Buffer.alloc(0) : Buffer.from([16, version])]);
    const text = 'otpauth-migration://offline?data=' + encodeURIComponent(payload.toString('base64'));
    const h = harness(); await h.files([{ text }]); h.render();
    assert.equal(h.button('导入 1 个账号').props.disabled, false);
    assert.doesNotMatch(h.text(), /未导入|暂不支持/);
    await h.button('导入 1 个账号').props.onClick();
    assert.equal(h.calls[0][1].accounts[0].algorithm, 'SHA1');
    assert.equal(h.calls[0][1].accounts[0].digits, 6);
    assert.equal(h.calls[0][1].accounts[0].account, 'alice');
    h.unmount();
  }
});

test('Google images without batch IDs require every frame and import all accounts once', async () => {
  const field = (id, value) => { const data = Buffer.from(value); return Buffer.concat([Buffer.from([id * 8 + 2, data.length]), data]); };
  const frame = (index, explicitZero = false, changed = false) => {
    const account = field(1, Buffer.concat([field(1, index ? 'another-secret-value!' : changed ? 'changed-secret-value!' : '12345678901234567890'), field(2, index ? 'bob' : 'alice'), field(3, 'Example')]));
    const payload = Buffer.concat([account, Buffer.from([16, 1, 24, 2]), index ? Buffer.from([32, index]) : Buffer.alloc(0), explicitZero ? Buffer.from([40, 0]) : Buffer.alloc(0)]);
    return 'otpauth-migration://offline?data=' + encodeURIComponent(payload.toString('base64'));
  };
  const h = harness();
  await h.files([{ text: frame(1) }]); h.render();
  assert.equal(h.button('导入 1 个账号').props.disabled, true);
  await h.button('导入 1 个账号').props.onClick();
  assert.equal(h.calls.length, 0);
  await h.files([{ text: frame(0) }, { text: frame(0, true) }, { text: frame(1) }]); h.render();
  assert.doesNotMatch(h.text(), /未导入|缺少批次标识/);
  assert.equal(h.button('导入 2 个账号').props.disabled, false);
  await h.files([{ text: frame(0, false, true) }]); h.render();
  assert.match(h.text(), /同一分片包含不同内容/);
  await h.button('导入 2 个账号').props.onClick();
  assert.equal(h.calls.length, 1);
  assert.deepEqual(Array.from(h.calls[0][1].accounts, item => item.account).sort(), ['alice', 'bob']);
  assert.equal(h.imports[0].imported, 2); h.unmount();
});
