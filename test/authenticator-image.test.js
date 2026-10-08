import test from 'node:test';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import { authenticatorImageDimensions } from '../shared/authenticator-image.js';

test('image headers are inspected before decode, including size bombs and disguised types', async () => {
  const png = await QRCode.toBuffer('test-only-qr', { width: 300 });
  assert.deepEqual(authenticatorImageDimensions(png, 'image/png'), { width: 300, height: 300 });
  assert.throws(() => authenticatorImageDimensions(png, 'image/jpeg'), /格式/);
  assert.throws(() => authenticatorImageDimensions(new Uint8Array([137, 80, 78]), 'image/png'), /格式/);
  const huge = Buffer.from(png);
  huge.writeUInt32BE(20000, 16);
  assert.throws(() => authenticatorImageDimensions(huge, 'image/png'), /尺寸过大/);
  huge.writeUInt32BE(4096, 16); huge.writeUInt32BE(4096, 20);
  assert.throws(() => authenticatorImageDimensions(huge, 'image/png'), /尺寸过大/);
  huge.writeUInt32BE(0, 16);
  assert.throws(() => authenticatorImageDimensions(huge, 'image/png'), /尺寸过大/);
});
