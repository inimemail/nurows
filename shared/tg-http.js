import http from 'node:http';

// A truncated reply must reject, rather than leave a shared poll/operation stuck.
// The deadline bounds the whole request, including a peer that drips bytes.
export function requestTgJson({ socketPath, path, method, data, timeout = 15000, maxBytes = 8 * 1024 ** 2 }) {
  return new Promise((resolve, reject) => {
    const body = data === undefined ? null : JSON.stringify(data);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(deadline);
      error ? reject(error) : resolve(value);
    };
    const req = http.request({ socketPath, path, method, headers: body === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { finish(Error('托管组件响应超过限制')); res.destroy(); req.destroy(); return; }
        chunks.push(chunk);
      });
      res.on('aborted', () => finish(Error('托管组件响应中断')));
      res.on('error', error => finish(error));
      res.on('end', () => {
        if (settled) return;
        try { finish(null, { statusCode: res.statusCode, data: size ? JSON.parse(Buffer.concat(chunks, size).toString('utf8')) : {} }); }
        catch { finish(Error('托管组件返回无效数据')); }
      });
    });
    const deadline = setTimeout(() => { finish(Error('托管组件请求超时')); req.destroy(); }, timeout);
    deadline.unref();
    req.on('error', error => finish(error)); req.end(body);
  });
}
