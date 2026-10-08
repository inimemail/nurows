import jsQR from 'jsqr';
import { authenticatorImageDimensions } from '../shared/authenticator-image.js';

self.onmessage = async ({ data: { kind, bytes, mime, pixels, width, height } }) => {
  try {
    if (kind === 'dimensions') {
      self.postMessage({ dimensions: authenticatorImageDimensions(bytes, mime) });
      return;
    }
    const result = jsQR(pixels, width, height);
    self.postMessage({ text: result?.data || '' });
  } catch (error) { self.postMessage({ error: kind === 'dimensions' ? error.message : '二维码识别失败' }); }
  finally { bytes?.fill(0); pixels?.fill(0); }
};
