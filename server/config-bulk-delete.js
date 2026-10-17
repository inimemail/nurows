import { bulkDeleteIds, partitionDeletion } from './bulk-delete.js';

export function registerConfigBulkDeleteRoutes(app, deps) {
  for (const [resource, key] of [['servers', 'servers'], ['proxies', 'proxies'], ['commands', 'commands'], ['automation-tasks', 'automationTasks']]) {
    app.post(`/api/${resource}/delete-all`, (req, res, next) => {
      try {
        const requested = bulkDeleteIds(req.body);
        let result;
        const state = deps.updateState(draft => {
          const active = new Set(), activeServers = new Set(), activeProxies = new Set();
          for (const job of key === 'commands' ? [] : deps.jobs()) {
            if (job.status === 'done') continue;
            if (job.type === 'automation') active.add(job.taskId);
            if (key === 'automationTasks') continue;
            for (const item of job.results || []) {
              if (!['queued', 'running', 'awaiting_input'].includes(item.status)) continue;
              activeServers.add(item.serverId);
              const proxyId = job.serverById?.get(item.serverId)?.proxyId;
              if (proxyId) activeProxies.add(proxyId);
            }
          }
          const webhookServers = new Set();
          if (key === 'servers') for (const task of deps.webhookTasks?.() || []) if (task.serverId) webhookServers.add(task.serverId);
          if (key === 'servers' || key === 'proxies') for (const run of deps.webhookRuns?.() || []) if (run.serverId) activeServers.add(run.serverId);
          if (key === 'proxies') for (const server of draft.servers || []) if (activeServers.has(server.id) && server.proxyId) activeProxies.add(server.proxyId);
          const linked = new Set(key === 'automationTasks' ? (draft.failoverPolicies || []).map(item => item.automationTaskId).filter(Boolean) : []);
          const partition = partitionDeletion(draft[key] || [], requested, item => {
            if (key === 'servers') return activeServers.has(item.id) ? '服务器正在执行命令' : webhookServers.has(item.id) ? '仍被 Webhook 任务引用，请先解除关联' : '';
            if (key === 'proxies') return activeProxies.has(item.id) ? '代理正被运行中的命令使用' : '';
            if (key === 'automationTasks') return active.has(item.id) ? '自动化任务正在执行' : linked.has(item.id) ? '仍被切换策略引用，请先解除关联' : '';
            return '';
          });
          result = partition.result;
          draft[key] = (draft[key] || []).filter(item => !partition.deleted.has(item.id));
          if (key === 'automationTasks') for (const bot of draft.telegramBots || []) bot.automationTaskIds = (bot.automationTaskIds || []).filter(id => !partition.deleted.has(id));
          if (key === 'proxies') for (const server of draft.servers || []) if (partition.deleted.has(server.proxyId)) Object.assign(server, { proxyId: '', updatedAt: new Date().toISOString() });
          return draft;
        });
        if (key === 'automationTasks' && result.deletedCount) deps.onTelegramChanged();
        res.json({ ok: true, ...result, state: deps.sanitizeState(state, req.auth) });
      } catch (error) { next(error); }
    });
  }
}
