import { createOtp } from '../shared/authenticator.js';

function workerCall(worker, data, transfer, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); worker.onmessage = worker.onerror = null; };
    const cancel = () => { stop(); worker.terminate(); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { stop(); worker.terminate(); reject(Error('图片处理超时，请换用较小的清晰图片')); }, timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onmessage = ({ data: result }) => { stop(); result.error ? reject(Error(result.error)) : resolve(result); };
    worker.onerror = () => { stop(); reject(Error('图片处理失败')); };
    try { worker.postMessage(data, transfer); } catch (error) { stop(); reject(error); }
  });
}

export async function readAuthenticatorQr(file, signal) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) throw Error('请选择 5 MB 以内的 PNG、JPEG 或 WebP 图片');
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  const worker = new Worker(new URL('./authenticator-qr-worker.js', import.meta.url), { type: 'module' });
  let url;
  const image = new Image();
  let canvas;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    try { await workerCall(worker, { kind: 'dimensions', bytes, mime: file.type }, [bytes.buffer], signal, 3000); }
    finally { if (bytes.byteLength) bytes.fill(0); }
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    url = URL.createObjectURL(file);
    image.src = url;
    await new Promise((resolve, reject) => {
      const finish = error => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); error ? reject(error) : resolve(); };
      const cancel = () => { image.src = ''; finish(new DOMException('Cancelled', 'AbortError')); };
      const timer = setTimeout(() => { image.src = ''; finish(Error('图片读取超时')); }, 10000);
      signal?.addEventListener('abort', cancel, { once: true });
      image.decode().then(() => finish(), () => finish(Error('图片无法读取，请换用有效图片')));
    });
    if (image.naturalWidth * image.naturalHeight > 16000000) throw Error('图片尺寸过大');
    const ratio = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    try {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const result = await workerCall(worker, { pixels: pixels.data, width: canvas.width, height: canvas.height }, [pixels.data.buffer], signal, 10000);
      if (!result.text) throw Error('未识别到二维码，请使用清晰完整的图片');
      return result.text;
    } finally { if (pixels.data.byteLength) pixels.data.fill(0); canvas.width = canvas.height = 0; }
  } finally { worker.terminate(); if (canvas) canvas.width = canvas.height = 0; image.src = ''; if (url) URL.revokeObjectURL(url); }
}

export async function authenticatorQr(config) {
  const { default: QRCode } = await import('qrcode');
  return QRCode.toDataURL(createOtp(config).toString(), { width: 300, margin: 2, errorCorrectionLevel: 'M' });
}
