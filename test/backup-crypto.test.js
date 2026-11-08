import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { encoder, decoder } from '../server/backup-crypto.cjs';

async function transform(chunks, codec) {
  const parts = [];
  await pipeline(Readable.from(chunks), codec, async stream => { for await (const chunk of stream) parts.push(chunk); });
  return Buffer.concat(parts);
}
test('deployment archives encrypt with bounded streams and reject wrong keys, altered headers, truncation and tampering', async () => {
  const key = crypto.randomBytes(32), data = Buffer.concat([Buffer.from('private-notes-and-credentials'), crypto.randomBytes(1024 * 1024)]);
  const encrypted = await transform([data.subarray(0, 1), data.subarray(1)], encoder(key));
  assert.equal(encrypted.includes(Buffer.from('private-notes-and-credentials')), false);
  const chunks = []; for (let i = 0; i < encrypted.length; i += 7919) chunks.push(encrypted.subarray(i, i + 7919));
  assert.deepEqual(await transform(chunks, decoder(key)), data);
  assert.deepEqual(await transform([...encrypted.subarray(0, 60)].map(b => Buffer.from([b])).concat([encrypted.subarray(60)]), decoder(key)), data);
  await assert.rejects(transform([encrypted], decoder(crypto.randomBytes(32))));
  for (const offset of [0, 18, 35, 75, encrypted.length - 1]) {
    const copy = Buffer.from(encrypted); copy[offset] ^= 1;
    await assert.rejects(transform([copy], decoder(key)));
  }
  for (const length of [0, 1, 30, encrypted.length - 1]) await assert.rejects(transform([encrypted.subarray(0, length)], decoder(key)));
  assert.deepEqual(await transform([await transform([], encoder(key))], decoder(key)), Buffer.alloc(0));
});
