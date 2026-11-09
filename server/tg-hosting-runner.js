import { WebSocket } from 'ws';
import { hostingError } from '../shared/tg-hosting.js';
import { requestTgJson } from '../shared/tg-http.js';

export function createTgRunnerClient(socketPath = process.env.TG_HOSTING_SOCKET || '') {
  async function request(method, endpoint, data, timeout = 15000) {
    if (!socketPath) throw hostingError('TG 托管组件尚未启用，请先按部署说明启动独立组件', 503);
    let response;
    try { response = await requestTgJson({ socketPath, path: endpoint, method, data, timeout }); }
    catch { throw hostingError('托管组件暂不可用，请检查组件状态；账号资料未删除', 503); }
    if (response.statusCode >= 300) throw hostingError(response.data.error || '托管组件操作失败', response.statusCode);
    return response.data;
  }
  return { enabled: Boolean(socketPath), request,
    connect(id) { return new WebSocket(`ws+unix://${socketPath}:/view/${id}`, { handshakeTimeout: 15000, perMessageDeflate: false }); } };
}
