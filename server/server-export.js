import { serverExportText } from '../shared/server-export.js';

export function registerServerExportRoutes(app, deps) {
  app.post('/api/groups/:id/export', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const { serverIds, mode } = req.body || {};
    if (!['import', 'ip'].includes(mode) || !Array.isArray(serverIds) || !serverIds.length || serverIds.length > 20000
      || serverIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 200)) {
      return res.status(400).json({ error: '请选择要导出的服务器和格式' });
    }
    const state = deps.readState(['groups', 'servers']);
    const group = state.groups.find(item => item.id === req.params.id);
    if (!group) return res.status(404).json({ error: '分组已不存在，请刷新后重试' });
    const ids = new Set(serverIds);
    const selected = state.servers.filter(server => server.groupId === group.id && ids.has(server.id));
    if (selected.length !== ids.size) return res.status(409).json({ error: '所选服务器已移出本组或已删除，请重新选择' });
    try {
      const text = serverExportText(selected, group.name, mode, server => deps.passwordFor(server, req.auth.encryptionKey));
      return res.json({ ok: true, text, count: selected.length });
    } catch {
      return res.status(400).json({ error: '服务器密码读取失败，请检查密码后重新导出' });
    }
  });
}
