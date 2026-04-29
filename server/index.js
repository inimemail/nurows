import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { Client as SSHClient } from 'ssh2';
import { SocksClient } from 'socks';
import { v4 as uuidv4 } from 'uuid';

loadRuntimeEnv();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const PORT = Number(process.env.PORT || 38471);
const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const sessions = new Map();
const authAttempts = new Map();
const commandJobs = new Map();
const MAX_AUTH_ATTEMPTS = 6;
const AUTH_WINDOW_MS = 1000 * 60 * 10;
const COMMAND_EXIT_MARKER = '__NUROSSH_EXIT__';
const COMMAND_PROMPT_PATTERNS = [
  /\[(?:Y\/n|y\/N|yes\/no)\]\s*$/i,
  /\((?:yes\/no)\)\s*$/i,
  /password[^\n]*:\s*$/i,
  /passphrase[^\n]*:\s*$/i,
  /(continue|confirm|proceed)[^\n]*\?\s*$/i,
  /(input|enter|type)[^\n]*:\s*$/i,
  /请输入[^\n]*[:：]?\s*$/u,
  /是否[^\n]*[?？]\s*$/u,
  /验证码[^\n]*[:：]?\s*$/u
];
const SHELL_PROMPT_PATTERNS = [
  /^[^@\s]+@[^:\s]+(?::.*)?[#$]\s*$/,
  /^\[[^@\]]+@[^ \]]+[^\]]*\][#$]\s*$/,
  /^[A-Za-z]:\\.*>\s*$/
];

const defaultState = {
  groups: [
    {
      id: 'group-default',
      name: '默认分组',
      note: '自动创建',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  ],
  servers: [],
  commands: [
    {
      id: uuidv4(),
      name: '查看负载',
      command: 'uptime && free -m && df -h',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    {
      id: uuidv4(),
      name: 'Docker 状态',
      command: 'docker ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
  ],
  proxies: [],
  workspaces: {}
};

function loadRuntimeEnv() {
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) {
      continue;
    }
    const value = rawValue.trim().replace(/^(['"])(.*)\1$/, '$2');
    process.env[key] = value;
  }
}

ensureStateFile();
cleanupExpiredSessions();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/api', authGuard);

app.get('/api/auth/status', (req, res) => {
  const auth = readAuth();
  const session = getSessionFromRequest(req);
  res.json({
    configured: auth.configured,
    authenticated: Boolean(session),
    username: session?.username || ''
  });
});

app.post('/api/auth/setup', (req, res) => {
  enforceAuthRateLimit(req, 'setup');
  const current = readAuth();
  if (current.configured) {
    res.status(400).json({ error: '管理员账户已初始化' });
    return;
  }

  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '').trim();
  if (!username) {
    res.status(400).json({ error: '请输入用户名' });
    return;
  }
  if (password.length < 4) {
    res.status(400).json({ error: '密码至少 4 位' });
    return;
  }

  const auth = createAuthRecord(username, password);
  writeAuth(auth);
  const session = createSession(username, deriveEncryptionKey(password, auth.salt));
  setSessionCookie(req, res, session.token);
  clearAuthRateLimit(req, 'setup');
  res.json({
    ok: true,
    configured: true,
    authenticated: true,
    username
  });
});

app.post('/api/auth/login', (req, res) => {
  enforceAuthRateLimit(req, 'login');
  const auth = readAuth();
  if (!auth.configured) {
    res.status(400).json({ error: '管理员账户尚未初始化' });
    return;
  }

  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '').trim();
  if (username !== auth.username || !verifyPassword(password, auth.salt, auth.hash)) {
    registerAuthFailure(req, 'login');
    res.status(401).json({ error: '账号或密码错误' });
    return;
  }

  const session = createSession(username, deriveEncryptionKey(password, auth.salt));
  setSessionCookie(req, res, session.token);
  clearAuthRateLimit(req, 'login');
  res.json({
    ok: true,
    configured: true,
    authenticated: true,
    username
  });
});

app.post('/api/auth/logout', (req, res) => {
  const token = getCookie(req.headers.cookie || '', 'nurossh_session');
  if (token) {
    sessions.delete(token);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.post('/api/auth/account', (req, res) => {
  enforceAuthRateLimit(req, 'account');
  const auth = readAuth();
  const currentPassword = String(req.body.currentPassword || '').trim();
  const nextUsername = String(req.body.username || '').trim() || auth.username;
  const nextPassword = String(req.body.newPassword || '').trim();
  const finalPassword = nextPassword || currentPassword;

  if (!verifyPassword(currentPassword, auth.salt, auth.hash)) {
    registerAuthFailure(req, 'account');
    res.status(401).json({ error: '当前密码错误' });
    return;
  }

  if (nextPassword && nextPassword.length < 4) {
    res.status(400).json({ error: '新密码至少 4 位' });
    return;
  }

  const nextAuth = createAuthRecord(nextUsername, finalPassword);
  const state = readState();
  if (
    auth.username !== nextUsername &&
    state.workspaces &&
    typeof state.workspaces === 'object' &&
    state.workspaces[auth.username] &&
    !state.workspaces[nextUsername]
  ) {
    state.workspaces[nextUsername] = state.workspaces[auth.username];
    delete state.workspaces[auth.username];
    writeState(state);
  }
  writeAuth(nextAuth);
  sessions.clear();

  const session = createSession(nextUsername, deriveEncryptionKey(finalPassword, nextAuth.salt));
  setSessionCookie(req, res, session.token);
  clearAuthRateLimit(req, 'account');

  res.json({
    ok: true,
    configured: true,
    authenticated: true,
    username: nextUsername
  });
});

app.get('/api/state', (req, res) => {
  res.json(sanitizeStateForClient(readState(), req.auth));
});

app.post('/api/workspace', (req, res) => {
  const workspaceInput = normalizeWorkspaceInput(req.body);
  const state = updateState((draft) => {
    if (!draft.workspaces || typeof draft.workspaces !== 'object') {
      draft.workspaces = {};
    }
    draft.workspaces[req.auth.username] = {
      ...workspaceInput,
      updatedAt: new Date().toISOString()
    };
    return draft;
  });
  res.json({
    ok: true,
    workspace: getWorkspaceForUser(state, req.auth)
  });
});

app.post('/api/groups', (req, res) => {
  const group = normalizeGroup(req.body);
  const state = updateState((draft) => {
    draft.groups.push(group);
    return draft;
  });
  res.json({ ok: true, state: sanitizeStateForClient(state, req.auth), item: group });
});

app.put('/api/groups/:id', (req, res) => {
  const state = updateState((draft) => {
    const item = draft.groups.find((group) => group.id === req.params.id);
    if (!item) {
      throw new Error('未找到分组');
    }

    item.name = String(req.body.name || '').trim() || item.name;
    item.note = String(req.body.note || '').trim();
    item.updatedAt = new Date().toISOString();
    return draft;
  });
  res.json({ ok: true, state: sanitizeStateForClient(state, req.auth) });
});

app.delete('/api/groups/:id', (req, res) => {
  const state = updateState((draft) => {
    if (req.params.id === 'group-default') {
      throw new Error('默认分组不能删除');
    }

    draft.groups = draft.groups.filter((group) => group.id !== req.params.id);
    draft.servers = draft.servers.map((serverItem) =>
      serverItem.groupId === req.params.id
        ? { ...serverItem, groupId: 'group-default', updatedAt: new Date().toISOString() }
        : serverItem
    );
    return draft;
  });
  res.json({ ok: true, state: sanitizeStateForClient(state, req.auth) });
});

app.post('/api/servers', (req, res) => {
  const state = updateState((draft) => {
    const serverItem = prepareServerForStorage(req.body, null, req.auth);
    ensureGroupExists(draft, serverItem.groupId);
    ensureProxyExists(draft, serverItem.proxyId);
    draft.servers.push(serverItem);
    req.createdItem = serverItem;
    return draft;
  });
  res.json({
    ok: true,
    state: sanitizeStateForClient(state, req.auth),
    item: sanitizeServerForClient(req.createdItem)
  });
});

app.put('/api/servers/:id', (req, res) => {
  const state = updateState((draft) => {
    const item = draft.servers.find((serverItem) => serverItem.id === req.params.id);
    if (!item) {
      throw new Error('未找到服务器');
    }

    const next = prepareServerForStorage(req.body, item, req.auth);
    ensureGroupExists(draft, next.groupId);
    ensureProxyExists(draft, next.proxyId);
    Object.assign(item, next, {
      id: item.id,
      createdAt: item.createdAt,
      updatedAt: new Date().toISOString()
    });
    return draft;
  });
  res.json({ ok: true, state: sanitizeStateForClient(state, req.auth) });
});

app.get('/api/servers/:id/password', (req, res) => {
  const state = readState();
  const item = state.servers.find((serverItem) => serverItem.id === req.params.id);
  if (!item) {
    res.status(404).json({ error: '未找到服务器配置' });
    return;
  }
  try {
    const password = getStoredSecretValue(item, req.auth.encryptionKey);
    res.json({ ok: true, password: password || '' });
  } catch (error) {
    res.status(400).json({ error: error.message || '密码无法解密，请重新保存密码' });
  }
});

app.delete('/api/servers/:id', (req, res) => {
  const state = updateState((draft) => {
    draft.servers = draft.servers.filter((serverItem) => serverItem.id !== req.params.id);
    return draft;
  });
  res.json({ ok: true, state: sanitizeStateForClient(state, req.auth) });
});

app.post('/api/commands', (req, res) => {
  const item = normalizeCommand(req.body);
  const state = updateState((draft) => {
    draft.commands.push(item);
    return draft;
  });
  res.json({ ok: true, state: sanitizeStateForClient(state, req.auth), item });
});

app.put('/api/commands/:id', (req, res) => {
  const state = updateState((draft) => {
    const item = draft.commands.find((commandItem) => commandItem.id === req.params.id);
    if (!item) {
      throw new Error('未找到命令');
    }

    item.name = String(req.body.name || '').trim() || item.name;
    item.command = String(req.body.command || '').trim() || item.command;
    item.updatedAt = new Date().toISOString();
    return draft;
  });
  res.json({ ok: true, state: sanitizeStateForClient(state, req.auth) });
});

app.delete('/api/commands/:id', (req, res) => {
  const state = updateState((draft) => {
    draft.commands = draft.commands.filter((commandItem) => commandItem.id !== req.params.id);
    return draft;
  });
  res.json({ ok: true, state: sanitizeStateForClient(state, req.auth) });
});

app.post('/api/proxies', (req, res) => {
  const state = updateState((draft) => {
    const item = prepareProxyForStorage(req.body, null, req.auth);
    draft.proxies.push(item);
    req.createdProxy = item;
    return draft;
  });
  res.json({
    ok: true,
    state: sanitizeStateForClient(state, req.auth),
    item: sanitizeProxyForClient(req.createdProxy)
  });
});

app.put('/api/proxies/:id', (req, res) => {
  const state = updateState((draft) => {
    const item = draft.proxies.find((proxyItem) => proxyItem.id === req.params.id);
    if (!item) {
      throw new Error('未找到代理');
    }

    const next = prepareProxyForStorage(req.body, item, req.auth);
    Object.assign(item, next, {
      id: item.id,
      createdAt: item.createdAt,
      updatedAt: new Date().toISOString()
    });
    return draft;
  });
  res.json({ ok: true, state: sanitizeStateForClient(state, req.auth) });
});

app.delete('/api/proxies/:id', (req, res) => {
  const state = updateState((draft) => {
    draft.proxies = draft.proxies.filter((proxyItem) => proxyItem.id !== req.params.id);
    draft.servers = draft.servers.map((serverItem) =>
      serverItem.proxyId === req.params.id
        ? { ...serverItem, proxyId: '', updatedAt: new Date().toISOString() }
        : serverItem
    );
    return draft;
  });
  res.json({ ok: true, state: sanitizeStateForClient(state, req.auth) });
});

app.post('/api/proxies/:id/assign', (req, res) => {
  const serverIds = Array.isArray(req.body.serverIds) ? req.body.serverIds : [];
  const state = updateState((draft) => {
    ensureProxyExists(draft, req.params.id);
    draft.servers = draft.servers.map((serverItem) =>
      serverIds.includes(serverItem.id)
        ? { ...serverItem, proxyId: req.params.id, updatedAt: new Date().toISOString() }
        : serverItem
    );
    return draft;
  });
  res.json({ ok: true, state: sanitizeStateForClient(state, req.auth) });
});

app.post('/api/proxies/:id/unassign', (req, res) => {
  const serverIds = Array.isArray(req.body.serverIds) ? req.body.serverIds : [];
  const clearAll = Boolean(req.body.clearAll);
  const state = updateState((draft) => {
    draft.servers = draft.servers.map((serverItem) => {
      const shouldClear = clearAll
        ? serverItem.proxyId === req.params.id
        : serverItem.proxyId === req.params.id && serverIds.includes(serverItem.id);
      return shouldClear
        ? { ...serverItem, proxyId: '', updatedAt: new Date().toISOString() }
        : serverItem;
    });
    return draft;
  });
  res.json({ ok: true, state: sanitizeStateForClient(state, req.auth) });
});

app.post('/api/import/preview', (req, res) => {
  const state = readState();
  const rows = parseImportText(String(req.body.text || ''));
  const preview = rows.map((item) => {
    const duplicate = findDuplicateServer(state.servers, item);
    return {
      ...item,
      duplicateId: duplicate?.id || '',
      duplicateName: duplicate?.name || '',
      duplicate: Boolean(duplicate)
    };
  });
  res.json({
    ok: true,
    total: preview.length,
    duplicateCount: preview.filter((item) => item.duplicate).length,
    items: preview
  });
});

app.post('/api/import/apply', (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const overwriteDuplicates = Boolean(req.body.overwriteDuplicates);

  const state = updateState((draft) => {
    for (const rawItem of items) {
      const item = prepareServerForStorage(rawItem, null, req.auth);
      const groupId = ensureGroupByNameOrId(draft, rawItem.groupName, item.groupId);
      item.groupId = groupId;
      ensureProxyExists(draft, item.proxyId);

      const duplicate = findDuplicateServer(draft.servers, item);
      if (duplicate) {
        if (!overwriteDuplicates) {
          continue;
        }
        Object.assign(
          duplicate,
          item,
          {
            id: duplicate.id,
            createdAt: duplicate.createdAt,
            updatedAt: new Date().toISOString()
          }
        );
      } else {
        draft.servers.push(item);
      }
    }

    return draft;
  });

  res.json({ ok: true, state: sanitizeStateForClient(state, req.auth) });
});

app.post('/api/commands/execute', async (req, res) => {
  const state = readState();
  const serverIds = Array.isArray(req.body.serverIds) ? req.body.serverIds : [];
  const commandText = String(req.body.commandText || '').trim();
  const commandId = String(req.body.commandId || '').trim();
  const interactiveKeywords = Array.isArray(req.body.interactiveKeywords)
    ? req.body.interactiveKeywords.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const commandItem = state.commands.find((item) => item.id === commandId);
  const finalCommand = commandText || commandItem?.command || '';

  if (!finalCommand) {
    res.status(400).json({ error: '命令不能为空' });
    return;
  }

  const selectedServers = state.servers.filter((item) => serverIds.includes(item.id));
  const job = createCommandJob(selectedServers, finalCommand, interactiveKeywords);
  commandJobs.set(job.id, job);
  runInteractiveCommandJob(job, state.proxies, req.auth.encryptionKey);

  res.json({
    ok: true,
    jobId: job.id,
    command: finalCommand,
    interactiveKeywords: job.interactiveKeywords,
    results: job.results
  });
});

app.get('/api/commands/jobs/:id', (req, res) => {
  const job = commandJobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: '执行任务不存在或已过期' });
    return;
  }

  for (const resultItem of job.results) {
    if (resultItem.status === 'done' || resultItem.status === 'error') {
      continue;
    }
    const runtime = job.sessions.get(resultItem.serverId) || null;
    tryFinalizeCommandResult(job, runtime, resultItem);
  }

  res.json({
    ok: true,
    jobId: job.id,
    command: job.command,
    interactiveKeywords: job.interactiveKeywords,
    status: job.status,
    results: job.results,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  });
});

app.post('/api/commands/jobs/:id/input', (req, res) => {
  const job = commandJobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: '任务不存在或已过期' });
    return;
  }

  const requestedServerIds = Array.isArray(req.body.serverIds)
    ? req.body.serverIds.filter((item) => typeof item === 'string')
    : [];
  const payload = typeof req.body.data === 'string' ? req.body.data : '';
  const raw = Boolean(req.body.raw);
  const targetServerIds = (requestedServerIds.length ? requestedServerIds : job.results.map((item) => item.serverId))
    .filter((serverId) => {
      const resultItem = job.results.find((item) => item.serverId === serverId);
      return resultItem && (resultItem.status === 'running' || resultItem.status === 'awaiting_input');
    });

  if (!targetServerIds.length) {
    res.status(400).json({ error: '当前没有可写入输入的执行会话' });
    return;
  }

  const normalizedInput = raw ? payload : normalizeCommandInput(payload);
  let sent = 0;

  for (const serverId of targetServerIds) {
    const runtime = job.sessions.get(serverId);
    const resultItem = job.results.find((item) => item.serverId === serverId);
    if (!runtime || !resultItem || !runtime.shellStream || runtime.closed) {
      continue;
    }
    writeCommandSessionInput(job, runtime, resultItem, normalizedInput);
    sent += 1;
  }

  res.json({ ok: true, sent });
});

app.post('/api/commands/jobs/:id/cancel', (req, res) => {
  const job = commandJobs.get(req.params.id);
  if (!job) {
    res.json({ ok: true, cancelled: false });
    return;
  }
  cancelCommandJob(job);
  commandJobs.delete(job.id);
  res.json({ ok: true, cancelled: true });
});

if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.get(/^(?!\/api|\/ws).*/, (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
      next();
      return;
    }
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
}

app.use((error, _req, res, _next) => {
  res.status(error.statusCode || 400).json({ error: error.message || '请求失败' });
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '', 'http://localhost');
  if (url.pathname !== '/ws/terminal' && url.pathname !== '/ws/command-job') {
    socket.destroy();
    return;
  }

  const session = getSessionFromRequest(req);
  if (!session) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '', 'http://localhost');
  if (url.pathname === '/ws/command-job') {
    handleCommandJobConnection(ws, req);
    return;
  }
  const serverId = url.searchParams.get('serverId') || '';
  const state = readState();
  const session = getSessionFromRequest(req);
  const serverItem = state.servers.find((item) => item.id === serverId);

  if (!serverItem) {
    ws.send(JSON.stringify({ type: 'error', message: '未找到服务器配置' }));
    ws.close();
    return;
  }

  const proxy = state.proxies.find((item) => item.id === serverItem.proxyId) || null;
  let serverPassword = '';
  let proxyPassword = '';
  try {
    serverPassword = getStoredSecretValue(serverItem, session.encryptionKey);
    proxyPassword = proxy ? getStoredSecretValue(proxy, session.encryptionKey) : '';
  } catch (error) {
    ws.send(JSON.stringify({ type: 'error', message: error.message || '密码无法解密，请重新保存密码' }));
    ws.close();
    return;
  }
  const ssh = new SSHClient();
  let shellStream = null;

  const closeAll = () => {
    if (shellStream) {
      shellStream.end();
      shellStream = null;
    }
    ssh.end();
    if (ws.readyState === ws.OPEN) {
      ws.close();
    }
  };

  ws.on('message', (raw) => {
    if (!shellStream) {
      return;
    }

    try {
      const message = JSON.parse(String(raw));
      if (message.type === 'input') {
        shellStream.write(message.data);
      }
      if (message.type === 'resize' && Number.isFinite(message.cols) && Number.isFinite(message.rows)) {
        shellStream.setWindow(message.rows, message.cols, 0, 0);
      }
    } catch (_error) {
      shellStream.write(String(raw));
    }
  });

  ws.on('close', () => {
    closeAll();
  });

  ws.on('error', () => {
    closeAll();
  });

  const connectOptions = buildConnectOptions(serverItem, serverPassword);
  if (proxy) {
    createProxySocket({ ...proxy, password: proxyPassword }, serverItem.host, serverItem.port)
      .then((socket) => {
        ssh.connect({ ...connectOptions, sock: socket });
      })
      .catch((error) => {
        ws.send(JSON.stringify({ type: 'error', message: `代理连接失败: ${error.message}` }));
        ws.close();
      });
  } else {
    ssh.connect(connectOptions);
  }

  ssh.on('ready', () => {
    ws.send(JSON.stringify({ type: 'ready' }));
    ssh.shell(
      {
        cols: 120,
        rows: 36,
        term: 'xterm-256color'
      },
      (error, stream) => {
        if (error) {
          ws.send(JSON.stringify({ type: 'error', message: error.message || '终端打开失败' }));
          ws.close();
          return;
        }

        shellStream = stream;
        stream.on('data', (chunk) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'output', data: chunk.toString('utf8') }));
          }
        });
        stream.stderr?.on('data', (chunk) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'output', data: chunk.toString('utf8') }));
          }
        });
        stream.on('close', () => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'closed' }));
          }
          closeAll();
        });
      }
    );
  });

  ssh.on('error', (error) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'error', message: error.message || 'SSH 连接失败' }));
    }
    ws.close();
  });

  ssh.on('close', () => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'closed' }));
      ws.close();
    }
  });
});

server.listen(PORT, () => {
  console.log(`WebSSH server running at http://localhost:${PORT}`);
});

function ensureStateFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(defaultState, null, 2), 'utf8');
  }

  if (!fs.existsSync(SECRET_FILE)) {
    fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'), 'utf8');
  }
}

function readAuth() {
  if (!fs.existsSync(AUTH_FILE)) {
    return {
      configured: false,
      username: '',
      salt: '',
      hash: '',
      updatedAt: ''
    };
  }

  const raw = fs.readFileSync(AUTH_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  return {
    configured: Boolean(parsed.configured),
    username: parsed.username || '',
    salt: parsed.salt || '',
    hash: parsed.hash || '',
    updatedAt: parsed.updatedAt || ''
  };
}

function writeAuth(auth) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), 'utf8');
}

function deriveEncryptionKey(password, salt) {
  return crypto.scryptSync(password, `nurossh:${salt}`, 32);
}

function getAppSecretKey() {
  ensureStateFile();
  return Buffer.from(fs.readFileSync(SECRET_FILE, 'utf8').trim(), 'hex');
}

function createAuthRecord(username, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    configured: true,
    username,
    salt,
    hash: hashPassword(password, salt),
    updatedAt: new Date().toISOString()
  };
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, hash) {
  const nextHash = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(nextHash, 'hex'), Buffer.from(hash, 'hex'));
}

function encryptSecret(value, encryptionKeyHex) {
  const secret = String(value || '');
  if (!secret) {
    return null;
  }
  const key = encryptionKeyHex
    ? (Buffer.isBuffer(encryptionKeyHex) ? encryptionKeyHex : Buffer.from(encryptionKeyHex, 'hex'))
    : getAppSecretKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: encrypted.toString('hex')
  };
}

function decryptSecret(secretObject, encryptionKeyHex) {
  if (!secretObject?.iv || !secretObject?.tag || !secretObject?.data) {
    return '';
  }
  const keys = [getAppSecretKey()];
  if (encryptionKeyHex) {
    try {
      keys.push(Buffer.isBuffer(encryptionKeyHex) ? encryptionKeyHex : Buffer.from(encryptionKeyHex, 'hex'));
    } catch (_error) {
      // Ignore malformed fallback keys.
    }
  }

  for (const key of keys) {
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(secretObject.iv, 'hex')
      );
      decipher.setAuthTag(Buffer.from(secretObject.tag, 'hex'));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(secretObject.data, 'hex')),
        decipher.final()
      ]);
      return decrypted.toString('utf8');
    } catch (_error) {
      // Try next available key.
    }
  }

  throw new Error('密码无法解密，请重新保存密码');
}

function createSession(username, encryptionKey) {
  const token = crypto.randomBytes(32).toString('hex');
  const record = {
    token,
    username,
    expiresAt: Date.now() + SESSION_TTL_MS,
    encryptionKey: encryptionKey.toString('hex')
  };
  sessions.set(token, record);
  return record;
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

function getSessionFromRequest(req) {
  cleanupExpiredSessions();
  const token = getCookie(req.headers.cookie || '', 'nurossh_session');
  if (!token) {
    return null;
  }
  const session = sessions.get(token);
  if (!session) {
    return null;
  }
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function setSessionCookie(req, res, token) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `nurossh_session=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'nurossh_session=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0');
}

function isSecureRequest(req) {
  return Boolean(req.secure || req.headers['x-forwarded-proto'] === 'https');
}

function getCookie(cookieHeader, name) {
  const cookies = String(cookieHeader || '').split(';');
  for (const item of cookies) {
    const [key, ...rest] = item.trim().split('=');
    if (key === name) {
      return decodeURIComponent(rest.join('='));
    }
  }
  return '';
}

function isPublicAuthRoute(req) {
  return (
    req.path === '/auth/status' ||
    req.path === '/auth/setup' ||
    req.path === '/auth/login'
  );
}

function getRateLimitKey(req, scope) {
  return `${scope}:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
}

function enforceAuthRateLimit(req, scope) {
  const key = getRateLimitKey(req, scope);
  const current = authAttempts.get(key);
  if (!current) {
    return;
  }
  if (current.until > Date.now() && current.count >= MAX_AUTH_ATTEMPTS) {
    const error = new Error('尝试次数过多，请稍后再试');
    error.statusCode = 429;
    throw error;
  }
  if (current.until <= Date.now()) {
    authAttempts.delete(key);
  }
}

function registerAuthFailure(req, scope) {
  const key = getRateLimitKey(req, scope);
  const now = Date.now();
  const current = authAttempts.get(key);
  if (!current || current.until <= now) {
    authAttempts.set(key, { count: 1, until: now + AUTH_WINDOW_MS });
    return;
  }
  current.count += 1;
  authAttempts.set(key, current);
}

function clearAuthRateLimit(req, scope) {
  authAttempts.delete(getRateLimitKey(req, scope));
}

function authGuard(req, res, next) {
  try {
    if (isPublicAuthRoute(req)) {
      next();
      return;
    }

    const auth = readAuth();
    if (!auth.configured) {
      res.status(401).json({ error: '请先初始化管理员账户', code: 'AUTH_SETUP_REQUIRED' });
      return;
    }

    const session = getSessionFromRequest(req);
    if (!session) {
      res.status(401).json({ error: '请先登录', code: 'AUTH_REQUIRED' });
      return;
    }

    migrateLegacySecrets(session);
    req.auth = session;
    next();
  } catch (error) {
    res.status(429).json({ error: error.message || '请求过于频繁' });
  }
}

function readState() {
  ensureStateFile();
  const raw = fs.readFileSync(STATE_FILE, 'utf8');
  const parsed = JSON.parse(raw);

  return {
    groups: Array.isArray(parsed.groups) && parsed.groups.length ? parsed.groups : defaultState.groups,
    servers: Array.isArray(parsed.servers) ? parsed.servers : [],
    commands: Array.isArray(parsed.commands) ? parsed.commands : [],
    proxies: Array.isArray(parsed.proxies) ? parsed.proxies : [],
    workspaces: parsed.workspaces && typeof parsed.workspaces === 'object' ? parsed.workspaces : {}
  };
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function updateState(mutator) {
  const draft = readState();
  const next = mutator(structuredClone(draft));
  writeState(next);
  return next;
}

function sanitizeStateForClient(state, auth = null) {
  return {
    groups: state.groups,
    commands: state.commands,
    servers: state.servers.map(sanitizeServerForClient),
    proxies: state.proxies.map(sanitizeProxyForClient),
    workspace: getWorkspaceForUser(state, auth)
  };
}

function getWorkspaceForUser(state, auth = null) {
  const username = String(auth?.username || '').trim();
  if (!username) {
    return {
      tab: 'servers',
      search: '',
      selectedServerId: '',
      selectedCommandId: '',
      selectedProxyId: '',
      selectedServerIds: [],
      commandText: '',
      collapsedGroups: {},
      executionResults: [],
      lastExecutedCommand: '',
      commandJobId: '',
      commandInteractiveKeywords: [],
      commandJobStatus: 'idle',
      sessions: [],
      activeTerminalId: '',
      updatedAt: ''
    };
  }
  const source = state.workspaces?.[username];
  if (!source || typeof source !== 'object') {
    return {
      tab: 'servers',
      search: '',
      selectedServerId: '',
      selectedCommandId: '',
      selectedProxyId: '',
      selectedServerIds: [],
      commandText: '',
      collapsedGroups: {},
      executionResults: [],
      lastExecutedCommand: '',
      commandJobId: '',
      commandInteractiveKeywords: [],
      commandJobStatus: 'idle',
      sessions: [],
      activeTerminalId: '',
      updatedAt: ''
    };
  }
  return {
    tab: source.tab === 'commands' || source.tab === 'proxies' ? source.tab : 'servers',
    search: typeof source.search === 'string' ? source.search : '',
    selectedServerId: typeof source.selectedServerId === 'string' ? source.selectedServerId : '',
    selectedCommandId: typeof source.selectedCommandId === 'string' ? source.selectedCommandId : '',
    selectedProxyId: typeof source.selectedProxyId === 'string' ? source.selectedProxyId : '',
    selectedServerIds: Array.isArray(source.selectedServerIds)
      ? source.selectedServerIds.filter((item) => typeof item === 'string')
      : [],
    commandText: typeof source.commandText === 'string' ? source.commandText : '',
    collapsedGroups: source.collapsedGroups && typeof source.collapsedGroups === 'object'
      ? Object.fromEntries(
          Object.entries(source.collapsedGroups).filter(([, value]) => typeof value === 'boolean')
        )
      : {},
    executionResults: Array.isArray(source.executionResults)
      ? source.executionResults
          .filter((item) => item && typeof item.serverId === 'string')
          .map((item) => ({
            serverId: item.serverId,
            name: typeof item.name === 'string' ? item.name : item.serverId,
            host: typeof item.host === 'string' ? item.host : '',
            ok: Boolean(item.ok),
            status: typeof item.status === 'string' ? item.status : 'done',
            stdout: typeof item.stdout === 'string' ? item.stdout : '',
            stderr: typeof item.stderr === 'string' ? item.stderr : '',
            exitCode: Number.isFinite(item.exitCode) ? item.exitCode : null,
            error: typeof item.error === 'string' ? item.error : '',
            awaitingInput: Boolean(item.awaitingInput),
            inputRequestCount: Number.isInteger(item.inputRequestCount) ? item.inputRequestCount : 0
          }))
      : [],
    lastExecutedCommand: typeof source.lastExecutedCommand === 'string' ? source.lastExecutedCommand : '',
    commandJobId: typeof source.commandJobId === 'string' ? source.commandJobId : '',
    commandInteractiveKeywords: Array.isArray(source.commandInteractiveKeywords)
      ? source.commandInteractiveKeywords
          .map((item) => String(item || '').trim())
          .filter(Boolean)
      : [],
    commandJobStatus:
      source.commandJobStatus === 'running' || source.commandJobStatus === 'done'
        ? source.commandJobStatus
        : 'idle',
    sessions: Array.isArray(source.sessions)
      ? source.sessions
          .filter((item) => item && typeof item.id === 'string' && typeof item.serverId === 'string')
          .map((item) => ({
            id: item.id,
            serverId: item.serverId,
            title: typeof item.title === 'string' ? item.title : item.serverId
          }))
      : [],
    activeTerminalId: typeof source.activeTerminalId === 'string' ? source.activeTerminalId : '',
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : ''
  };
}

function normalizeWorkspaceInput(input = {}) {
  return {
    tab: input.tab === 'commands' || input.tab === 'proxies' ? input.tab : 'servers',
    search: typeof input.search === 'string' ? input.search : '',
    selectedServerId: typeof input.selectedServerId === 'string' ? input.selectedServerId : '',
    selectedCommandId: typeof input.selectedCommandId === 'string' ? input.selectedCommandId : '',
    selectedProxyId: typeof input.selectedProxyId === 'string' ? input.selectedProxyId : '',
    selectedServerIds: Array.isArray(input.selectedServerIds)
      ? input.selectedServerIds.filter((item) => typeof item === 'string')
      : [],
    commandText: typeof input.commandText === 'string' ? input.commandText : '',
    collapsedGroups: input.collapsedGroups && typeof input.collapsedGroups === 'object'
      ? Object.fromEntries(
          Object.entries(input.collapsedGroups).filter(([, value]) => typeof value === 'boolean')
        )
      : {},
    executionResults: Array.isArray(input.executionResults)
      ? input.executionResults
          .filter((item) => item && typeof item.serverId === 'string')
          .map((item) => ({
            serverId: item.serverId,
            name: typeof item.name === 'string' ? item.name : item.serverId,
            host: typeof item.host === 'string' ? item.host : '',
            ok: Boolean(item.ok),
            status: typeof item.status === 'string' ? item.status : 'done',
            stdout: typeof item.stdout === 'string' ? item.stdout : '',
            stderr: typeof item.stderr === 'string' ? item.stderr : '',
            exitCode: Number.isFinite(item.exitCode) ? item.exitCode : null,
            error: typeof item.error === 'string' ? item.error : '',
            awaitingInput: Boolean(item.awaitingInput),
            inputRequestCount: Number.isInteger(item.inputRequestCount) ? item.inputRequestCount : 0
          }))
      : [],
    lastExecutedCommand: typeof input.lastExecutedCommand === 'string' ? input.lastExecutedCommand : '',
    commandJobId: typeof input.commandJobId === 'string' ? input.commandJobId : '',
    commandInteractiveKeywords: Array.isArray(input.commandInteractiveKeywords)
      ? input.commandInteractiveKeywords
          .map((item) => String(item || '').trim())
          .filter(Boolean)
      : [],
    commandJobStatus:
      input.commandJobStatus === 'running' || input.commandJobStatus === 'done'
        ? input.commandJobStatus
        : 'idle',
    sessions: Array.isArray(input.sessions)
      ? input.sessions
          .filter((item) => item && typeof item.id === 'string' && typeof item.serverId === 'string')
          .map((item) => ({
            id: item.id,
            serverId: item.serverId,
            instanceNo: Number.isInteger(item.instanceNo) && item.instanceNo >= 0 ? item.instanceNo : 0,
            title: typeof item.title === 'string' ? item.title : item.serverId
          }))
      : [],
    activeTerminalId: typeof input.activeTerminalId === 'string' ? input.activeTerminalId : ''
  };
}

function createCommandJob(selectedServers, command, interactiveKeywords = []) {
  const now = new Date().toISOString();
  return {
    id: uuidv4(),
    command,
    interactiveKeywords: Array.isArray(interactiveKeywords)
      ? interactiveKeywords.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    status: 'running',
    startedAt: now,
    finishedAt: '',
    cancelled: false,
    sessions: new Map(),
    pendingClients: new Map(),
    cleanupTimer: null,
    results: selectedServers.map((serverItem) => ({
      serverId: serverItem.id,
      name: serverItem.name,
      host: serverItem.host,
      ok: false,
      status: 'queued',
      stdout: '',
      stderr: '',
      exitCode: null,
      error: '',
      awaitingInput: false,
      inputRequestCount: 0
    }))
  };
}

async function runCommandJob(job, proxies, encryptionKeyHex) {
  const tasks = job.results.map(async (resultItem) => {
    resultItem.status = 'running';
    try {
      const serverItem = readState().servers.find((item) => item.id === resultItem.serverId);
      if (!serverItem) {
        throw new Error('服务器不存在');
      }

      const output = await execOnServer(serverItem, proxies, job.command, encryptionKeyHex);
      Object.assign(resultItem, output, {
        ok: true,
        status: 'done',
        error: ''
      });
    } catch (error) {
      Object.assign(resultItem, {
        ok: false,
        status: 'error',
        stdout: '',
        stderr: '',
        exitCode: null,
        error: error.message || '执行失败'
      });
    }
  });

  Promise.allSettled(tasks).then(() => {
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    setTimeout(() => {
      commandJobs.delete(job.id);
    }, 1000 * 60 * 10);
  });
}

function runInteractiveCommandJob(job, proxies, encryptionKeyHex) {
  for (const resultItem of job.results) {
    const serverItem = readState().servers.find((item) => item.id === resultItem.serverId);
    if (!serverItem) {
      Object.assign(resultItem, {
        ok: false,
        status: 'error',
        error: '服务器不存在',
        awaitingInput: false
      });
      continue;
    }
    startInteractiveCommandSession(job, resultItem, serverItem, proxies, encryptionKeyHex);
  }

  refreshCommandJobStatus(job);
}

function startInteractiveCommandSession(job, resultItem, serverItem, proxies, encryptionKeyHex) {
  const proxy = proxies.find((item) => item.id === serverItem.proxyId) || null;
  let serverPassword = '';
  let proxyPassword = '';
  try {
    serverPassword = getStoredSecretValue(serverItem, encryptionKeyHex);
    proxyPassword = proxy ? getStoredSecretValue(proxy, encryptionKeyHex) : '';
  } catch (error) {
    Object.assign(resultItem, {
      ok: false,
      status: 'error',
      error: error.message || '密码无法解密，请重新保存密码',
      awaitingInput: false
    });
    refreshCommandJobStatus(job);
    return;
  }

  const ssh = new SSHClient();
  const runtime = {
    ssh,
    serverId: resultItem.serverId,
    shellStream: null,
    clients: new Set(),
    awaitingTimer: null,
    closeTimer: null,
    closed: false,
    cancelRequested: false,
    tailText: '',
    commandDispatched: false
  };
  const pendingClients = job.pendingClients.get(resultItem.serverId);
  if (pendingClients?.size) {
    runtime.clients = new Set(pendingClients);
    job.pendingClients.delete(resultItem.serverId);
  }
  job.sessions.set(resultItem.serverId, runtime);
  resultItem.status = 'running';

  const finalizeRuntime = () => {
    if (runtime.closed) {
      return;
    }
    runtime.closed = true;
    if (runtime.awaitingTimer) {
      clearTimeout(runtime.awaitingTimer);
      runtime.awaitingTimer = null;
    }
    if (runtime.closeTimer) {
      clearTimeout(runtime.closeTimer);
      runtime.closeTimer = null;
    }
    if (runtime.shellStream) {
      runtime.shellStream.end();
      runtime.shellStream = null;
    }
    ssh.end();
    broadcastCommandSession(runtime, { type: 'closed' });
  };

  const markRuntimeError = (message) => {
    if (job.cancelled || runtime.cancelRequested) {
      return;
    }
    if (resultItem.status === 'done' || resultItem.status === 'error') {
      return;
    }
    Object.assign(resultItem, {
      ok: false,
      status: 'error',
      error: message || '执行失败',
      awaitingInput: false
    });
    if (!resultItem.stdout) {
      resultItem.stdout = `[系统] ${resultItem.error}\r\n`;
    }
    broadcastCommandSession(runtime, { type: 'state', status: resultItem.status, awaitingInput: false });
    refreshCommandJobStatus(job);
  };

  const connectOptions = buildConnectOptions(serverItem, serverPassword);
  const connectWithSocket = (socket) => {
    ssh.connect(socket ? { ...connectOptions, sock: socket } : connectOptions);
  };

  if (proxy) {
    createProxySocket({ ...proxy, password: proxyPassword }, serverItem.host, serverItem.port)
      .then((socket) => connectWithSocket(socket))
      .catch((error) => markRuntimeError(`代理连接失败: ${error.message}`));
  } else {
    connectWithSocket(null);
  }

  ssh.on('ready', () => {
    ssh.shell(
      {
        cols: 120,
        rows: 36,
        term: 'xterm-256color'
      },
      (error, stream) => {
        if (error) {
          markRuntimeError(error.message || '终端打开失败');
          finalizeRuntime();
          return;
        }

        runtime.shellStream = stream;
        broadcastCommandSession(runtime, { type: 'ready' });

        stream.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          appendCommandRuntimeOutput(job, runtime, resultItem, text);
        });
        stream.stderr?.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          appendCommandRuntimeOutput(job, runtime, resultItem, text);
        });
        stream.on('close', () => {
          runtime.shellStream = null;
          if (resultItem.status !== 'done' && resultItem.status !== 'error') {
            markRuntimeError('连接已关闭');
          }
          finalizeRuntime();
        });

        setTimeout(() => {
          if (!runtime.shellStream || runtime.closed || runtime.commandDispatched) {
            return;
          }
          runtime.commandDispatched = true;
          runtime.shellStream.write(buildInteractiveCommandScript(job.command));
          scheduleAwaitingInputCheck(job, runtime, resultItem);
        }, 120);
      }
    );
  });

  ssh.on('error', (error) => {
    markRuntimeError(error.message || 'SSH 连接失败');
  });

  ssh.on('close', () => {
    if (!runtime.closed && resultItem.status !== 'done' && resultItem.status !== 'error') {
      markRuntimeError('连接已关闭');
    }
    finalizeRuntime();
  });
}

function appendCommandRuntimeOutput(job, runtime, resultItem, text) {
  resultItem.stdout += text;
  runtime.tailText = `${runtime.tailText}${stripAnsi(String(text || ''))}`.slice(-1200);
  broadcastCommandSession(runtime, { type: 'output', data: text });

  if (tryFinalizeCommandResult(job, runtime, resultItem)) {
    return;
  }

  if (resultItem.status !== 'done' && resultItem.status !== 'error') {
    resultItem.status = 'running';
    resultItem.awaitingInput = false;
    scheduleAwaitingInputCheck(job, runtime, resultItem);
  }
}

function scheduleAwaitingInputCheck(job, runtime, resultItem) {
  if (runtime.awaitingTimer) {
    clearTimeout(runtime.awaitingTimer);
  }
  if (resultItem.status === 'done' || resultItem.status === 'error' || runtime.closed) {
    return;
  }

  runtime.awaitingTimer = setTimeout(() => {
    if (resultItem.status !== 'running' || runtime.closed) {
      return;
    }
    if (!looksLikeInteractivePrompt(runtime.tailText, job.interactiveKeywords)) {
      return;
    }
    resultItem.status = 'awaiting_input';
    resultItem.awaitingInput = true;
    resultItem.inputRequestCount += 1;
    broadcastCommandSession(runtime, { type: 'state', status: resultItem.status, awaitingInput: true });
    refreshCommandJobStatus(job);
  }, 1300);
}

function refreshCommandJobStatus(job) {
  const unfinished = job.results.some((item) => !['done', 'error'].includes(item.status));
  if (unfinished) {
    job.status = 'running';
    return;
  }
  if (job.status === 'done') {
    return;
  }
  job.status = 'done';
  job.finishedAt = new Date().toISOString();
  if (job.cleanupTimer) {
    clearTimeout(job.cleanupTimer);
  }
  job.cleanupTimer = setTimeout(() => {
    commandJobs.delete(job.id);
  }, 1000 * 60 * 10);
}

function cancelCommandJob(job) {
  job.cancelled = true;
  job.status = 'done';
  job.finishedAt = new Date().toISOString();
  if (job.cleanupTimer) {
    clearTimeout(job.cleanupTimer);
    job.cleanupTimer = null;
  }

  for (const resultItem of job.results) {
    if (!['done', 'error'].includes(resultItem.status)) {
      resultItem.status = 'error';
      resultItem.ok = false;
      resultItem.awaitingInput = false;
      resultItem.error = '已取消';
      if (!resultItem.stdout) {
        resultItem.stdout = '[系统] 已取消当前执行任务。\r\n';
      }
    }
  }

  for (const [, runtime] of job.sessions) {
    runtime.cancelRequested = true;
    if (runtime.awaitingTimer) {
      clearTimeout(runtime.awaitingTimer);
      runtime.awaitingTimer = null;
    }
    if (runtime.closeTimer) {
      clearTimeout(runtime.closeTimer);
      runtime.closeTimer = null;
    }
    try {
      runtime.shellStream?.write('\u0003');
      runtime.shellStream?.end('exit\r');
    } catch (_error) {
      // Ignore best-effort cancellation failures.
    }
    try {
      runtime.ssh.end();
    } catch (_error) {
      // Ignore best-effort cancellation failures.
    }
    broadcastCommandSession(runtime, { type: 'state', status: 'error', awaitingInput: false });
    broadcastCommandSession(runtime, { type: 'closed' });
  }

  for (const [, clients] of job.pendingClients) {
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        client.send(JSON.stringify({ type: 'closed' }));
        client.close();
      }
    }
  }
}

function handleCommandJobConnection(ws, req) {
  const url = new URL(req.url || '', 'http://localhost');
  const jobId = url.searchParams.get('jobId') || '';
  const serverId = url.searchParams.get('serverId') || '';
  const job = commandJobs.get(jobId);
  const resultItem = job?.results.find((item) => item.serverId === serverId) || null;
  const runtime = job?.sessions.get(serverId) || null;

  if (!job || !resultItem) {
    ws.send(JSON.stringify({ type: 'error', message: '执行会话不存在或已过期' }));
    ws.close();
    return;
  }

  if (runtime) {
    runtime.clients.add(ws);
  } else {
    if (!job.pendingClients.has(serverId)) {
      job.pendingClients.set(serverId, new Set());
    }
    job.pendingClients.get(serverId).add(ws);
  }

  ws.on('message', (raw) => {
    const activeRuntime = job.sessions.get(serverId);
    if (!activeRuntime || !resultItem) {
      return;
    }
    try {
      const message = JSON.parse(String(raw));
      if (message.type === 'input') {
        writeCommandSessionInput(job, activeRuntime, resultItem, String(message.data || ''));
      }
      if (message.type === 'resize' && Number.isFinite(message.cols) && Number.isFinite(message.rows) && activeRuntime.shellStream) {
        activeRuntime.shellStream.setWindow(message.rows, message.cols, 0, 0);
      }
    } catch (_error) {
      writeCommandSessionInput(job, activeRuntime, resultItem, String(raw));
    }
  });

  const cleanupClient = () => {
    runtime?.clients.delete(ws);
    job.pendingClients.get(serverId)?.delete(ws);
  };
  ws.on('close', cleanupClient);
  ws.on('error', cleanupClient);

  ws.send(JSON.stringify({ type: 'ready' }));
  ws.send(JSON.stringify({ type: 'history', data: resultItem.stdout || '' }));
  ws.send(JSON.stringify({
    type: 'state',
    status: resultItem.status,
    awaitingInput: Boolean(resultItem.awaitingInput)
  }));
  if (runtime?.closed) {
    ws.send(JSON.stringify({ type: 'closed' }));
  }
}

function writeCommandSessionInput(job, runtime, resultItem, data) {
  if (!runtime.shellStream || runtime.closed) {
    return;
  }
  if (runtime.awaitingTimer) {
    clearTimeout(runtime.awaitingTimer);
    runtime.awaitingTimer = null;
  }
  if (resultItem.status !== 'done') {
    resultItem.status = 'running';
    resultItem.awaitingInput = false;
  }
  runtime.shellStream.write(data);
  broadcastCommandSession(runtime, { type: 'state', status: resultItem.status, awaitingInput: false });
  if (resultItem.status !== 'done') {
    scheduleAwaitingInputCheck(job, runtime, resultItem);
  }
}

function broadcastCommandSession(runtime, payload) {
  for (const client of runtime.clients) {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }
}

function normalizeCommandInput(value) {
  const text = typeof value === 'string' ? value : '';
  if (!text.length) {
    return '\r';
  }
  return /[\r\n]$/.test(text) ? text.replace(/\n/g, '\r') : `${text}\r`;
}

function extractCommandExitCode(text) {
  const match = String(text || '').match(new RegExp(`${COMMAND_EXIT_MARKER}:(-?\\d+)`));
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

function stripCommandExitMarker(text) {
  return String(text || '').replace(new RegExp(`\\r?\\n?${COMMAND_EXIT_MARKER}:-?\\d+\\r?\\n?`, 'g'), '\r\n');
}

function stripAnsi(text) {
  return String(text || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function getLastNonEmptyLine(text) {
  const lines = String(text || '')
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] || '';
}

function looksLikeShellPromptLine(text) {
  const line = String(text || '').trim();
  return SHELL_PROMPT_PATTERNS.some((pattern) => pattern.test(line));
}

function finalizeCommandResult(job, runtime, resultItem, exitCode) {
  resultItem.exitCode = exitCode;
  resultItem.ok = exitCode === 0;
  resultItem.status = 'done';
  resultItem.error = '';
  resultItem.awaitingInput = false;
  if (runtime?.awaitingTimer) {
    clearTimeout(runtime.awaitingTimer);
    runtime.awaitingTimer = null;
  }
  broadcastCommandSession(runtime, { type: 'history', data: resultItem.stdout });
  broadcastCommandSession(runtime, { type: 'state', status: resultItem.status, awaitingInput: false });
  refreshCommandJobStatus(job);
}

function tryFinalizeCommandResult(job, runtime, resultItem) {
  const exitCode = extractCommandExitCode(resultItem.stdout);
  if (exitCode !== null) {
    resultItem.stdout = stripCommandExitMarker(resultItem.stdout);
    finalizeCommandResult(job, runtime, resultItem, exitCode);
    return true;
  }

  const tailSource = runtime?.tailText || stripAnsi(resultItem.stdout);
  const lastLine = getLastNonEmptyLine(tailSource);
  if (resultItem.inputRequestCount > 0 && looksLikeShellPromptLine(lastLine)) {
    finalizeCommandResult(job, runtime, resultItem, 0);
    return true;
  }

  return false;
}

function looksLikeInteractivePrompt(text, interactiveKeywords = []) {
  const keywords = Array.isArray(interactiveKeywords)
    ? interactiveKeywords.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const lines = String(text || '')
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8);
  const lastLine = lines[lines.length - 1] || '';
  if (!lastLine) {
    return false;
  }
  if (SHELL_PROMPT_PATTERNS.some((pattern) => pattern.test(lastLine))) {
    return false;
  }
  if (keywords.some((keyword) => keyword && lastLine.includes(keyword))) {
    return true;
  }
  if (lastLine.includes('\u8bf7')) {
    return true;
  }
  return COMMAND_PROMPT_PATTERNS.some((pattern) => pattern.test(lastLine));
}

function buildInteractiveCommandScript(command) {
  const body = String(command || '').replace(/\r/g, '').trimEnd();
  return `__nurossh_run() {\n${body}\n}\n__nurossh_run; __NUROSSH_STATUS=$?; printf '\\n${COMMAND_EXIT_MARKER}:%s\\n' "$__NUROSSH_STATUS"; unset -f __nurossh_run; exit "$__NUROSSH_STATUS"\n`;
}

function sanitizeServerForClient(serverItem) {
  const { password, passwordEnc, ...safe } = serverItem;
  return safe;
}

function sanitizeProxyForClient(proxyItem) {
  const { password, passwordEnc, ...safe } = proxyItem;
  return safe;
}

function normalizeGroup(input = {}) {
  const now = new Date().toISOString();
  return {
    id: input.id || uuidv4(),
    name: String(input.name || '').trim() || '未命名分组',
    note: String(input.note || '').trim(),
    createdAt: input.createdAt || now,
    updatedAt: now
  };
}

function normalizeServer(input = {}) {
  const now = new Date().toISOString();
  return {
    id: input.id || uuidv4(),
    name: String(input.name || '').trim() || '未命名服务器',
    host: String(input.host || '').trim(),
    port: clampPort(input.port),
    username: String(input.username || 'root').trim() || 'root',
    passwordEnc: input.passwordEnc || null,
    groupId: String(input.groupId || 'group-default').trim() || 'group-default',
    proxyId: String(input.proxyId || '').trim(),
    note: String(input.note || '').trim(),
    createdAt: input.createdAt || now,
    updatedAt: now
  };
}

function prepareServerForStorage(input = {}, existing = null, session = null) {
  const base = normalizeServer({
    ...existing,
    ...input,
    id: existing?.id || input.id,
    createdAt: existing?.createdAt || input.createdAt
  });
  const plainPassword = String(input.password || '').trim();
  if (plainPassword) {
    base.passwordEnc = encryptSecret(plainPassword);
  } else if (existing?.passwordEnc) {
    base.passwordEnc = existing.passwordEnc;
  } else if (existing?.password) {
    base.passwordEnc = encryptSecret(existing.password);
  } else {
    base.passwordEnc = null;
  }
  delete base.password;
  return base;
}

function normalizeCommand(input = {}) {
  const now = new Date().toISOString();
  return {
    id: input.id || uuidv4(),
    name: String(input.name || '').trim() || '未命名命令',
    command: String(input.command || '').trim(),
    createdAt: input.createdAt || now,
    updatedAt: now
  };
}

function normalizeProxy(input = {}) {
  const now = new Date().toISOString();
  const type = ['socks5', 'http'].includes(String(input.type || '').trim()) ? input.type : 'http';
  return {
    id: input.id || uuidv4(),
    name: String(input.name || '').trim() || '未命名代理',
    type,
    host: String(input.host || '').trim(),
    port: clampPort(input.port),
    username: String(input.username || '').trim(),
    passwordEnc: input.passwordEnc || null,
    createdAt: input.createdAt || now,
    updatedAt: now
  };
}

function prepareProxyForStorage(input = {}, existing = null, session = null) {
  const base = normalizeProxy({
    ...existing,
    ...input,
    id: existing?.id || input.id,
    createdAt: existing?.createdAt || input.createdAt
  });
  const plainPassword = String(input.password || '').trim();
  if (plainPassword) {
    base.passwordEnc = encryptSecret(plainPassword);
  } else if (existing?.passwordEnc) {
    base.passwordEnc = existing.passwordEnc;
  } else if (existing?.password) {
    base.passwordEnc = encryptSecret(existing.password);
  } else {
    base.passwordEnc = null;
  }
  delete base.password;
  return base;
}

function clampPort(value) {
  const port = Number(value);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    return 22;
  }
  return port;
}

function ensureGroupExists(state, groupId) {
  const exists = state.groups.some((group) => group.id === groupId);
  if (!exists) {
    throw new Error('分组不存在');
  }
}

function ensureProxyExists(state, proxyId) {
  if (!proxyId) {
    return;
  }
  const exists = state.proxies.some((proxy) => proxy.id === proxyId);
  if (!exists) {
    throw new Error('代理不存在');
  }
}

function ensureGroupByNameOrId(state, groupName, groupId) {
  const existingById = state.groups.find((group) => group.id === groupId);
  if (existingById) {
    return existingById.id;
  }

  const nextName = String(groupName || '').trim();
  if (!nextName) {
    return 'group-default';
  }

  const existingByName = state.groups.find((group) => group.name === nextName);
  if (existingByName) {
    return existingByName.id;
  }

  const group = normalizeGroup({ name: nextName });
  state.groups.push(group);
  return group.id;
}

function getStoredSecretValue(item, encryptionKeyHex) {
  if (item?.passwordEnc) {
    return decryptSecret(item.passwordEnc, encryptionKeyHex);
  }
  return String(item?.password || '');
}

function migrateLegacySecrets(session) {
  const state = readState();
  let changed = false;

  for (const serverItem of state.servers) {
    if (serverItem.password && !serverItem.passwordEnc) {
      serverItem.passwordEnc = encryptSecret(serverItem.password);
      delete serverItem.password;
      changed = true;
      continue;
    }

    if (serverItem.passwordEnc) {
      try {
        decryptSecret(serverItem.passwordEnc);
      } catch (_error) {
        try {
          const legacyPassword = decryptSecret(serverItem.passwordEnc, session.encryptionKey);
          serverItem.passwordEnc = encryptSecret(legacyPassword);
          changed = true;
        } catch (_legacyError) {
          // Leave as-is. The user will need to re-save the password if this cannot be recovered.
        }
      }
    }
  }

  for (const proxyItem of state.proxies) {
    if (proxyItem.password && !proxyItem.passwordEnc) {
      proxyItem.passwordEnc = encryptSecret(proxyItem.password);
      delete proxyItem.password;
      changed = true;
      continue;
    }

    if (proxyItem.passwordEnc) {
      try {
        decryptSecret(proxyItem.passwordEnc);
      } catch (_error) {
        try {
          const legacyPassword = decryptSecret(proxyItem.passwordEnc, session.encryptionKey);
          proxyItem.passwordEnc = encryptSecret(legacyPassword);
          changed = true;
        } catch (_legacyError) {
          // Leave as-is. The user will need to re-save the password if this cannot be recovered.
        }
      }
    }
  }

  if (changed) {
    writeState(state);
  }
}

function findDuplicateServer(servers, item) {
  const host = String(item.host || '').trim().toLowerCase();
  const username = String(item.username || 'root').trim().toLowerCase();
  const name = String(item.name || '').trim().toLowerCase();
  const port = clampPort(item.port);

  return (
    servers.find(
      (serverItem) =>
        serverItem.host.trim().toLowerCase() === host &&
        clampPort(serverItem.port) === port &&
        serverItem.username.trim().toLowerCase() === username
    ) ||
    servers.find(
      (serverItem) =>
        serverItem.name.trim().toLowerCase() === name &&
        serverItem.host.trim().toLowerCase() === host
    ) ||
    null
  );
}

function parseImportText(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const tokens = tokenizeRow(line);
      if (tokens.length < 2) {
        throw new Error(`导入格式错误: ${line}`);
      }

      const [name, host, third, fourth, fifth, sixth] = tokens;
      let port = 22;
      let username = 'root';
      let password = '';
      let groupName = '';

      if (third && /^\d+$/.test(third)) {
        port = Number(third);
        username = fourth || 'root';
        password = fifth || '';
        groupName = sixth || '';
      } else {
        username = third || 'root';
        password = fourth || '';
        groupName = fifth || '';
      }

      return {
        id: uuidv4(),
        name,
        host,
        port,
        username,
        password,
        groupId: 'group-default',
        groupName,
        proxyId: '',
        note: ''
      };
    });
}

function tokenizeRow(line) {
  const matches = line.match(/"([^"]*)"|'([^']*)'|[^\s,|]+/g) || [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ''));
}

function buildConnectOptions(serverItem, password) {
  return {
    host: serverItem.host,
    port: serverItem.port,
    username: serverItem.username,
    password,
    readyTimeout: 15000,
    keepaliveInterval: 5000,
    keepaliveCountMax: 6,
    tryKeyboard: false
  };
}

async function execOnServer(serverItem, proxies, command, encryptionKeyHex) {
  const proxy = proxies.find((item) => item.id === serverItem.proxyId) || null;
  const serverPassword = getStoredSecretValue(serverItem, encryptionKeyHex);
  const proxyPassword = proxy ? getStoredSecretValue(proxy, encryptionKeyHex) : '';
  const ssh = new SSHClient();

  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler, payload) => {
      if (settled) {
        return;
      }
      settled = true;
      ssh.end();
      handler(payload);
    };

    const connect = (socket) => {
      const options = {
        host: serverItem.host,
        port: serverItem.port,
        username: serverItem.username,
        password: serverPassword,
        readyTimeout: 15000,
        sock: socket
      };
      ssh.connect(socket ? options : { ...options, sock: undefined });
    };

    if (proxy) {
      createProxySocket({ ...proxy, password: proxyPassword }, serverItem.host, serverItem.port)
        .then((socket) => connect(socket))
        .catch((error) => finish(reject, error));
    } else {
      connect(null);
    }

    ssh.on('ready', () => {
      ssh.exec(command, (error, stream) => {
        if (error) {
          finish(reject, error);
          return;
        }

        let stdout = '';
        let stderr = '';
        let exitCode = null;

        stream.on('data', (chunk) => {
          stdout += chunk.toString('utf8');
        });
        stream.stderr.on('data', (chunk) => {
          stderr += chunk.toString('utf8');
        });
        stream.on('exit', (code) => {
          exitCode = code;
        });
        stream.on('close', () => {
          finish(resolve, { stdout, stderr, exitCode });
        });
      });
    });

    ssh.on('error', (error) => {
      finish(reject, error);
    });
  });
}

async function createProxySocket(proxy, destinationHost, destinationPort) {
  if (proxy.type === 'socks5') {
    const result = await SocksClient.createConnection({
      command: 'connect',
      proxy: {
        host: proxy.host,
        port: clampPort(proxy.port),
        type: 5,
        userId: proxy.username || undefined,
        password: proxy.password || undefined
      },
      destination: {
        host: destinationHost,
        port: destinationPort
      }
    });
    return result.socket;
  }

  return await connectViaHttpProxy(proxy, destinationHost, destinationPort);
}

function connectViaHttpProxy(proxy, destinationHost, destinationPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(clampPort(proxy.port), proxy.host);
    socket.setTimeout(15000);

    socket.once('error', (error) => {
      reject(error);
    });

    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('HTTP 代理连接超时'));
    });

    socket.once('connect', () => {
      const auth = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64')}\r\n`
        : '';
      const request =
        `CONNECT ${destinationHost}:${destinationPort} HTTP/1.1\r\n` +
        `Host: ${destinationHost}:${destinationPort}\r\n` +
        auth +
        '\r\n';
      socket.write(request);
    });

    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      if (!buffer.includes('\r\n\r\n')) {
        return;
      }

      socket.off('data', onData);
      if (/^HTTP\/1\.[01] 200/i.test(buffer)) {
        socket.setTimeout(0);
        resolve(socket);
        return;
      }

      socket.destroy();
      reject(new Error(`HTTP 代理握手失败: ${buffer.split('\r\n')[0] || 'unknown'}`));
    };

    socket.on('data', onData);
  });
}
