import { registerOrchestrationRoutes } from './orchestration.js';
import { registerDynamicGuardRoutes } from './dynamic-guard.js';

// Reuse the web route business rules in-process, without HTTP, credentials,
// or serializing a full client state for each Telegram operation.
export function createTelegramActions(deps, dynamicService) {
  const routes = new Map();
  const app = Object.fromEntries(['get', 'post', 'put', 'delete'].map((method) =>
    [method, (path, handler) => routes.set(`${method.toUpperCase()} ${path}`, handler)]));
  const localDeps = { ...deps, sanitizeState: () => undefined };
  registerOrchestrationRoutes(app, localDeps);
  registerDynamicGuardRoutes(app, localDeps, dynamicService);
  return async (method, route, params, body, actor) => {
    const handler = routes.get(`${method} ${route}`);
    if (!handler) throw new Error('不支持的操作');
    let result, status = 200, failure;
    const response = { status(code) { status = code; return this; }, set() { return this; },
      json(value) { result = value; return this; } };
    await handler({ params, body, query: {}, auth: { username: actor } }, response, (error) => { failure = error; });
    if (failure) throw failure;
    if (status >= 400) throw new Error(result?.error || '操作失败');
    return result;
  };
}
