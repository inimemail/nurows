import { requestTgJson } from './tg-http.js';

const minor = version => typeof version === 'string' && /^1\.\d{1,3}$/.test(version) ? Number(version.slice(2)) : NaN;

// Discover without an API prefix: newer engines may reject v1.41 before any
// container operation. Keep using the oldest supported API our requests need.
export function createTgDockerClient(socketPath) {
  let apiVersion, discovering;
  async function request(method, endpoint, data, timeout) {
    const response = await requestTgJson({ socketPath, path: endpoint, method, data, timeout });
    if (response.statusCode >= 300) {
      const detail = typeof response.data?.message === 'string' ? response.data.message.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 320) : '';
      // Invalidate for the next request, never replay a mutation after a failure.
      if (response.statusCode === 400 && /client version|minimum supported API version|maximum supported API version/i.test(detail)) apiVersion = undefined;
      throw Object.assign(Error(`Docker 操作失败（${response.statusCode}）${detail ? `：${detail}` : '，请检查托管组件和浏览器镜像'}`), { dockerStatus: response.statusCode });
    }
    return response.data;
  }
  async function discover() {
    const version = await request('GET', '/version', undefined, 5000);
    const maximum = minor(version?.ApiVersion), minimum = minor(version?.MinAPIVersion ?? '1.12');
    if (!Number.isFinite(maximum) || !Number.isFinite(minimum) || minimum > maximum) throw Error('Docker 返回的 API 版本范围无效，请检查 Docker 服务');
    if (maximum < 41) throw Error('Docker API 版本过旧，需要支持 v1.41 或更新版本，请升级 Docker');
    apiVersion = `v1.${Math.max(41, minimum)}`;
    return apiVersion;
  }
  return async function docker(method, endpoint, data, timeout = 30000) {
    if (!apiVersion) {
      discovering ||= discover().finally(() => { discovering = null; });
      await discovering;
    }
    return request(method, `/${apiVersion}${endpoint}`, data, timeout);
  };
}
