import test from 'node:test';
import assert from 'node:assert/strict';
import { tgViewerSize } from '../shared/tg-hosting.js';
import { relayTgFrame } from '../shared/tg-frame-relay.js';

test('viewer bounds 4K rendering while preserving desktop/mobile aspect ratio', () => {
  for (const [width, height] of [[4096, 2060], [3840, 2160], [1440, 900], [390, 720], [320, 400], [844, 300]]) {
    const size = tgViewerSize(width, height);
    assert.ok(size.width <= 1440 && size.height <= 900);
    assert.ok(Math.abs(size.width / size.height - width / height) < .01);
    if (width <= 1440 && height <= 900) assert.deepEqual(size, { width, height });
  }
  for (const value of [0, -1, NaN, Infinity]) assert.equal(tgViewerSize(value, 900), null);
});

test('slow VNC viewers pause their producer and resume after ordered bytes drain', () => {
  let paused = false;
  const source = { pause() { paused = true; }, resume() { paused = false; } };
  const queue = [], received = [], closes = [];
  const target = { readyState: 1, bufferedAmount: 0, close(code) { closes.push(code); },
    send(data, options, callback) { assert.equal(options.binary, true); this.bufferedAmount += data.length; queue.push(() => { received.push(data); this.bufferedAmount -= data.length; callback(); }); } };
  const chunks = [Buffer.alloc(128 * 1024, 1), Buffer.alloc(128 * 1024, 2), Buffer.alloc(128 * 1024, 3)];
  for (const data of chunks) relayTgFrame(source, target, data);
  assert.equal(paused, true);
  queue.shift()(); assert.equal(paused, true);
  queue.shift()(); assert.equal(paused, false);
  queue.shift()(); assert.deepEqual(Buffer.concat(received), Buffer.concat(chunks));
  assert.deepEqual(closes, []);
});

test('relay retains hard buffer limits and fails closed on write errors', () => {
  const source = { pause() {}, resume() { assert.fail('failed send must not resume input'); } };
  let code;
  const target = { readyState: 1, bufferedAmount: 900, close(value) { code = value; }, send() { assert.fail('over-limit payload must not be sent'); } };
  relayTgFrame(source, target, Buffer.alloc(200), { limit: 1024 }); assert.equal(code, 1013);
  target.bufferedAmount = 0; target.send = (_data, _options, callback) => callback(Error('write failed'));
  relayTgFrame(source, target, Buffer.alloc(10)); assert.equal(code, 1011);
  target.readyState = 3; target.send = () => assert.fail('closed sockets must not be written');
  relayTgFrame(source, target, Buffer.alloc(10));
});
