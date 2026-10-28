import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeEpayUrl, publicEpayAddress, requestEpay } from '../server/epay-api.js';

test('epay URL validation requires HTTPS and rejects private endpoints', () => {
  assert.equal(normalizeEpayUrl('https://pay.example.com/'), 'https://pay.example.com/');
  assert.equal(normalizeEpayUrl('https://pay.example.com/api.php'), 'https://pay.example.com/');
  assert.throws(() => normalizeEpayUrl('http://pay.example.com/'), /HTTPS/);
  assert.throws(() => normalizeEpayUrl('https://127.0.0.1/'), /公网/);
  assert.equal(publicEpayAddress('8.8.8.8'), true);
  assert.equal(publicEpayAddress('192.168.1.1'), false);
  assert.equal(publicEpayAddress('::ffff:192.168.1.1'), false);
});

test('epay requests pin a checked public address and never expose the key in errors', async () => {
  let options, requestedUrl;
  const response = { statusCode: 200, on(event, handler) { if (event === 'data') handler(Buffer.from('{"code":1,"money":"1.00"}')); if (event === 'end') handler(); return this; }, resume() {} };
  const request = (url, nextOptions, callback) => {
    requestedUrl = String(url); options = nextOptions; callback(response); return { on() { return this; }, end() {} };
  };
  const result = await requestEpay({ url: 'https://pay.example.com/', pid: '1001' }, 'secret-key', 'query', {}, { lookup: async () => [{ address: '8.8.8.8', family: 4 }], request });
  assert.equal(result.money, '1.00');
  assert.match(requestedUrl, /act=query/); assert.match(requestedUrl, /pid=1001/); assert.match(requestedUrl, /key=secret-key/);
  assert.equal(options.lookup('ignored', { all: false }, (error, address, family) => { assert.ifError(error); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); }), undefined);
  let all;
  options.lookup('ignored', { all: true }, (error, addresses) => { assert.ifError(error); all = addresses; });
  assert.deepEqual(all, [{ address: '8.8.8.8', family: 4 }]);
});

test('aborted requests do not resolve or connect and mixed private DNS answers fail closed', async () => {
  let lookups = 0, connections = 0;
  const options = { signal: AbortSignal.abort(), lookup: async () => { lookups++; return []; }, request: () => { connections++; } };
  const account = { url: 'https://pay.example.com/', pid: '1001' };
  await assert.rejects(requestEpay(account, 'secret-key', 'query', {}, options));
  assert.equal(lookups, 0); assert.equal(connections, 0);
  await assert.rejects(requestEpay(account, 'secret-key', 'query', {}, { ...options, signal: undefined,
    lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), /非公网地址/);
  assert.equal(connections, 0);
});

test('explicitly empty legacy order pages are accepted without hiding credential or other API errors', async () => {
  const account = { url: 'https://pay.example.com/', pid: '1001' };
  const send = (body, act = 'orders') => requestEpay(account, 'secret-key', act, {}, {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request(_url, _options, callback) {
      callback({ statusCode: 200, on(event, handler) { if (event === 'data') handler(Buffer.from(JSON.stringify(body))); if (event === 'end') handler(); return this; } });
      return { on() { return this; }, end() {} };
    }
  });
  assert.deepEqual(await send({ code: -1, msg: '暂无订单' }), { code: 1, data: [] });
  assert.deepEqual(await send({ code: 0, msg: '没有更多订单！', data: [] }), { code: 1, data: [] });
  await assert.rejects(send({ code: -1, msg: '商户密钥错误' }), /订单列表查询失败/);
  await assert.rejects(send({ code: -1, msg: '未知错误' }), /订单列表查询失败/);
  await assert.rejects(send({ code: -1, msg: '暂无订单' }, 'query'), /商户信息查询失败/);
  await assert.rejects(send({ code: -1, msg: '暂无订单', data: [{ trade_no: 'unexpected' }] }), /订单列表查询失败/);
});

test('API failures report bounded codes and local reason labels without leaking remote response details', async () => {
  const send = body => requestEpay({ url: 'https://pay.example.com/', pid: '1001' }, 'secret-key', 'orders', {}, {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request(_url, _options, callback) {
      callback({ statusCode: 200, on(event, handler) { if (event === 'data') handler(Buffer.from(JSON.stringify(body))); if (event === 'end') handler(); return this; } });
      return { on() { return this; }, end() {} };
    }
  });
  for (const [message, expected] of [['请求过于频繁', '查询频率'], ['未开启API查询权限', '查询权限'], ['商户密钥错误', '凭证校验'], ['不支持此参数', '不支持当前查询'], ['订单不存在', '订单已不存在'], ['未知错误', '拒绝了本次查询']]) {
    await assert.rejects(send({ code: -1, msg: `${message} https://pay.example.com/api.php?key=secret-key buyer=private-buyer` }), error => {
      assert.equal(error.epaySafe, true); assert.equal(error.statusCode, 400);
      assert.match(error.message, /订单列表查询失败.*返回码 -1/); assert.ok(error.message.includes(expected));
      assert.doesNotMatch(error.message, /secret-key|private-buyer|https:|api\.php/);
      return true;
    });
  }
  await assert.rejects(send({ code: 'secret-key', msg: 'private-buyer' }), error => {
    assert.doesNotMatch(error.message, /secret-key|private-buyer|返回码/); return true;
  });
});
