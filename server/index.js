import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import Database from 'better-sqlite3';
import { WebSocketServer } from 'ws';
import { Client as SSHClient } from 'ssh2';
import { SocksClient } from 'socks';
import { v4 as uuidv4 } from 'uuid';
import { hasExactPerServerInputs } from '../shared/command-input.js';
import {
  normalizeOrchestrationState,
  orchestrationDefaults,
  registerOrchestrationRoutes,
  registerProbePublicRoutes,
  runIncidentWorkflow,
  rollbackIncident,
  sanitizeOrchestrationState
} from './orchestration.js';

loadRuntimeEnv();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 38471);
const ROOT_DIR = process.cwd();
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const LEGACY_STATE_FILE = path.join(DATA_DIR, 'state.json');
const LEGACY_AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const LEGACY_SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const SQLITE_FILE = resolveSqlitePath(process.env.SQLITE_DB_PATH || path.join(DATA_DIR, 'app.db'));
const SQLITE_KV_TABLE = 'app_kv';
const STORAGE_KEYS = {
  auth: 'auth',
  state: 'state',
  secret: 'secret'
};
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const SSH_KEEPALIVE_INTERVAL_MS = readDurationMs(process.env.SSH_KEEPALIVE_INTERVAL || process.env.SSH_KEEPALIVE_INTERVAL_MS, 15000);
const SSH_KEEPALIVE_COUNT_MAX = clampInteger(process.env.SSH_KEEPALIVE_COUNT_MAX, 3, 1, 100);
const WEBSOCKET_PING_INTERVAL_MS = readDurationMs(process.env.WEBSOCKET_PING_INTERVAL || process.env.WEBSOCKET_PING_INTERVAL_MS, 20000);
const TERMINAL_REATTACH_GRACE_MS = 1000 * 60 * 60 * 12;
const TERMINAL_HISTORY_LIMIT = 1000 * 1000;
const sessions = new Map();
const terminalSessions = new Map();
const authAttempts = new Map();
const probeRegistrationAttempts = new Map();
const commandJobs = new Map();
const telegramRuntime = {
  timer: null,
  offsets: new Map(),
  token: '',
  pending: new Map(),
  progressTimers: new Map(),
  generation: 0
};
let sqliteDb = null;
let cachedAuth = null;
let cachedState = null;
let cachedSecretHex = '';
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

const orchestrationDeps = {
  readState,
  updateState,
  sanitizeState: sanitizeStateForClient,
  encryptSecret,
  decryptSecret,
  executeAutomation: executeAutomationForIncident,
  waitAutomation: waitForAutomationJob,
  runIncident: (incidentId, encryptionKey) => runIncidentWorkflow(incidentId, orchestrationDeps, encryptionKey),
  notifyIncident: notifyIncidentViaTelegram
};
orchestrationDeps.allowProbeRegistration = (ip) => {
  const key = String(ip || 'unknown');
  const now = Date.now();
  const current = probeRegistrationAttempts.get(key);
  if (!current || current.until <= now) {
    probeRegistrationAttempts.set(key, { count: 1, until: now + 10 * 60 * 1000 });
    return true;
  }
  if (current.count >= 12) return false;
  current.count += 1;
  return true;
};

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
  commands: [],
  proxies: [],
  automationTasks: [],
  automationRuns: [],
  telegram: {
    enabled: false,
    tokenEnc: null,
    userIds: [],
    allowGroups: true
  },
  ...orchestrationDefaults(),
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

ensureStorage();
cleanupExpiredSessions();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  const origin = String(req.headers.origin || '');
  if (origin) {
    try {
      const expectedHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
      const allowedOrigins = new Set(String(process.env.ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean));
      const originUrl = new URL(origin);
      const localDevOrigin = ['localhost', '127.0.0.1', '[::1]'].includes(originUrl.hostname) && originUrl.port === '5173';
      if (originUrl.host !== expectedHost && !allowedOrigins.has(origin) && !localDevOrigin) {
        res.status(403).json({ error: '请求来源校验失败' });
        return;
      }
    } catch (_error) {
      res.status(403).json({ error: '请求来源校验失败' });
      return;
    }
  }
  next();
});
registerProbePublicRoutes(app, {
  readState,
  updateState,
  onIncidentCreated: (incidentId) => runIncidentWorkflow(incidentId, orchestrationDeps)
});
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

registerOrchestrationRoutes(app, orchestrationDeps);

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
    ensureUniqueGroupName(draft, group.name);
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

    const nextName = String(req.body.name || '').trim() || item.name;
    ensureUniqueGroupName(draft, nextName, item.id);
    item.name = nextName;
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
    draft.servers = draft.servers.filter((serverItem) => serverItem.groupId !== req.params.id);
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

app.delete('/api/terminal-sessions/:id', (req, res) => {
  const runtime = terminalSessions.get(sanitizeTerminalRuntimeId(req.params.id));
  if (runtime) {
    closeTerminalRuntime(runtime, true);
  }
  res.json({ ok: true });
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

app.post('/api/automation-tasks', (req, res) => {
  const state = updateState((draft) => {
    const item = normalizeAutomationTask(req.body);
    const password = String(req.body.password || '').trim();
    if (password) item.passwordEnc = encryptSecret(password);
    draft.automationTasks.push(item);
    req.createdAutomationTask = item;
    return draft;
  });
  res.json({ ok: true, state: sanitizeStateForClient(state, req.auth), item: sanitizeAutomationTaskForClient(req.createdAutomationTask) });
});

app.put('/api/automation-tasks/:id', (req, res) => {
  const state = updateState((draft) => {
    const item = draft.automationTasks.find((task) => task.id === req.params.id);
    if (!item) throw new Error('未找到自动化任务');
    const next = normalizeAutomationTask(req.body, item);
    const password = String(req.body.password || '').trim();
    next.passwordEnc = password ? encryptSecret(password) : item.passwordEnc;
    Object.assign(item, next, { id: item.id, createdAt: item.createdAt });
    return draft;
  });
  res.json({ ok: true, state: sanitizeStateForClient(state, req.auth) });
});

app.delete('/api/automation-tasks/:id', (req, res) => {
  const state = updateState((draft) => {
    draft.automationTasks = draft.automationTasks.filter((task) => task.id !== req.params.id);
    return draft;
  });
  res.json({ ok: true, state: sanitizeStateForClient(state, req.auth) });
});

app.post('/api/automation-tasks/:id/execute', (req, res) => {
  const state = readState();
  const task = state.automationTasks.find((item) => item.id === req.params.id);
  if (!task) { res.status(404).json({ error: '自动化任务不存在' }); return; }
  const hosts = [...new Set(String(req.body.hosts || '').split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean))].slice(0, 5000);
  if (!hosts.length) { res.status(400).json({ error: '请输入至少一个 IP 或主机地址' }); return; }
  const password = getStoredSecretValue(task, req.auth.encryptionKey);
  if (!password) { res.status(400).json({ error: '请先为自动化任务设置 SSH 密码' }); return; }
  const commandSteps = task.steps.filter((step) => step.type === 'command' && step.value.trim());
  const command = commandSteps.map((step) => step.value.trim()).join('\n');
  if (!command) { res.status(400).json({ error: '请至少配置一个命令步骤' }); return; }
  const job = startAutomationTask(task, hosts, state, req.auth.encryptionKey);
  res.json({ ok: true, jobId: job.id, taskId: task.id, results: job.results });
});

app.post('/api/automation-jobs/:id/cancel', (req, res) => {
  const job = commandJobs.get(req.params.id);
  if (!job || job.type !== 'automation') { res.status(404).json({ error: '自动化任务不存在或已过期' }); return; }
  cancelCommandJob(job);
  res.json({ ok: true, results: job.results });
});

app.post('/api/automation-jobs/:id/pause', (req, res) => {
  const job = commandJobs.get(req.params.id);
  if (!job || job.type !== 'automation') { res.status(404).json({ error: '自动化任务不存在或已过期' }); return; }
  job.paused = true;
  res.json({ ok: true, status: 'paused' });
});

app.post('/api/automation-jobs/:id/resume', (req, res) => {
  const job = commandJobs.get(req.params.id);
  if (!job || job.type !== 'automation') { res.status(404).json({ error: '自动化任务不存在或已过期' }); return; }
  job.paused = false;
  res.json({ ok: true, status: 'running' });
});

app.post('/api/automation-jobs/:id/retry-failed', (req, res) => {
  const previous = commandJobs.get(req.params.id);
  if (!previous || previous.type !== 'automation') { res.status(404).json({ error: '自动化任务不存在或已过期' }); return; }
  const hosts = previous.results.filter((item) => item.status === 'error').map((item) => item.host);
  if (!hosts.length) { res.status(400).json({ error: '没有失败主机' }); return; }
  const state = readState();
  const task = state.automationTasks.find((item) => item.id === previous.taskId);
  if (!task) { res.status(404).json({ error: '自动化配置不存在' }); return; }
  const job = startAutomationTask(task, hosts, state, req.auth.encryptionKey);
  res.json({ ok: true, jobId: job.id, results: job.results });
});

app.put('/api/telegram', (req, res) => {
  const state = updateState((draft) => {
    const next = normalizeTelegramSettings({ ...draft.telegram, ...req.body });
    const token = String(req.body.token || '').trim();
    next.tokenEnc = token ? encryptSecret(token) : draft.telegram?.tokenEnc || null;
    draft.telegram = next;
    return draft;
  });
  restartTelegramPolling();
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

  if (Array.isArray(req.body.inputs)) {
    const inputs = req.body.inputs;
    const resultByServerId = new Map(job.results.map((item) => [item.serverId, item]));
    const awaitingResults = job.results.filter(
      (item) => item.status === 'awaiting_input' || item.awaitingInput
    );
    const awaitingServerIds = awaitingResults.map((item) => item.serverId);

    if (!hasExactPerServerInputs(inputs, awaitingServerIds)) {
      res.status(400).json({ error: '输入行数与服务器数量不一致' });
      return;
    }

    const targets = inputs.map((item) => ({
      runtime: job.sessions.get(item.serverId),
      resultItem: resultByServerId.get(item.serverId),
      data: normalizeCommandInput(item.data)
    }));
    if (targets.some(({ runtime, resultItem }) => !runtime || !resultItem || !runtime.shellStream || runtime.closed)) {
      res.status(400).json({ error: '当前没有可写入输入的执行会话' });
      return;
    }

    for (const target of targets) {
      writeCommandSessionInput(job, target.runtime, target.resultItem, target.data);
    }
    res.json({ ok: true, sent: targets.length });
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
  attachWebSocketHeartbeat(ws);

  const url = new URL(req.url || '', 'http://localhost');
  if (url.pathname === '/ws/command-job') {
    handleCommandJobConnection(ws, req);
    return;
  }
  handleTerminalConnection(ws, req, url);
  return;
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

server.listen(PORT, HOST, () => {
  restartTelegramPolling();
  resumePendingIncidents();
  console.log(`NuroSSH server running at http://localhost:${PORT}`);
});

function resumePendingIncidents() {
  const state = readState();
  for (const incident of state.incidents || []) {
    if (['queued', 'observing', 'allocating', 'automating', 'dns_updating', 'verifying'].includes(incident.status)) {
      updateState((draft) => {
        const item = draft.incidents.find((entry) => entry.id === incident.id);
        if (item && !['succeeded', 'rolled_back'].includes(item.status)) Object.assign(item, { status: 'queued', executionId: '', message: '服务已恢复，继续执行', updatedAt: new Date().toISOString() });
        return draft;
      });
      orchestrationDeps.runIncident(incident.id).catch?.(() => {});
    }
  }
}

function handleTerminalConnection(ws, req, url) {
  const serverId = url.searchParams.get('serverId') || '';
  const terminalId = sanitizeTerminalRuntimeId(url.searchParams.get('terminalId') || serverId);
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

  let runtime = terminalSessions.get(terminalId);
  if (runtime && runtime.serverId !== serverId) {
    closeTerminalRuntime(runtime, true);
    runtime = null;
  }
  if (!runtime || runtime.closed) {
    runtime = createTerminalRuntime({
      id: terminalId,
      serverId,
      serverItem,
      serverPassword,
      proxy,
      proxyPassword
    });
    terminalSessions.set(terminalId, runtime);
  }

  attachTerminalClient(runtime, ws);
}

function createTerminalRuntime({ id, serverId, serverItem, serverPassword, proxy, proxyPassword }) {
  const ssh = new SSHClient();
  const runtime = {
    id,
    serverId,
    ssh,
    shellStream: null,
    clients: new Set(),
    history: '',
    closed: false,
    closeTimer: null,
    ready: false,
    errorMessage: ''
  };

  const appendOutput = (text) => {
    runtime.history = `${runtime.history}${text}`.slice(-TERMINAL_HISTORY_LIMIT);
    broadcastTerminalSession(runtime, { type: 'output', data: text });
  };

  const markClosed = (message = '') => {
    if (runtime.closed) {
      return;
    }
    runtime.closed = true;
    runtime.errorMessage = message;
    broadcastTerminalSession(runtime, message ? { type: 'error', message } : { type: 'closed' });
    closeTerminalRuntime(runtime, false);
  };

  const connectOptions = buildConnectOptions(serverItem, serverPassword);
  const connect = (socket) => {
    ssh.connect(socket ? { ...connectOptions, sock: socket } : connectOptions);
  };

  if (proxy) {
    createProxySocket({ ...proxy, password: proxyPassword }, serverItem.host, serverItem.port)
      .then((socket) => connect(socket))
      .catch((error) => markClosed(`代理连接失败: ${error.message}`));
  } else {
    connect(null);
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
          markClosed(error.message || '终端打开失败');
          return;
        }

        runtime.ready = true;
        runtime.shellStream = stream;
        broadcastTerminalSession(runtime, { type: 'ready' });

        stream.on('data', (chunk) => {
          appendOutput(chunk.toString('utf8'));
        });
        stream.stderr?.on('data', (chunk) => {
          appendOutput(chunk.toString('utf8'));
        });
        stream.on('close', () => {
          runtime.shellStream = null;
          markClosed();
        });
      }
    );
  });

  ssh.on('error', (error) => {
    markClosed(error.message || 'SSH 连接失败');
  });

  ssh.on('close', () => {
    markClosed();
  });

  return runtime;
}

function attachTerminalClient(runtime, ws) {
  if (runtime.closeTimer) {
    clearTimeout(runtime.closeTimer);
    runtime.closeTimer = null;
  }

  ws.on('message', (raw) => {
    if (!runtime.shellStream || runtime.closed) {
      return;
    }

    try {
      const message = JSON.parse(String(raw));
      if (message.type === 'input') {
        runtime.shellStream.write(message.data);
      }
      if (message.type === 'resize' && Number.isFinite(message.cols) && Number.isFinite(message.rows)) {
        runtime.shellStream.setWindow(message.rows, message.cols, 0, 0);
      }
    } catch (_error) {
      runtime.shellStream.write(String(raw));
    }
  });

  const cleanupClient = () => {
    runtime.clients.delete(ws);
    if (!runtime.closed && !runtime.clients.size && !runtime.closeTimer) {
      runtime.closeTimer = setTimeout(() => {
        closeTerminalRuntime(runtime, true);
      }, TERMINAL_REATTACH_GRACE_MS);
    }
  };
  ws.on('close', cleanupClient);
  ws.on('error', cleanupClient);

  runtime.clients.add(ws);
  if (runtime.ready) {
    ws.send(JSON.stringify({ type: 'ready' }));
  }
  if (runtime.history) {
    ws.send(JSON.stringify({ type: 'history', data: runtime.history }));
  }
  if (runtime.closed) {
    ws.send(JSON.stringify(runtime.errorMessage ? { type: 'error', message: runtime.errorMessage } : { type: 'closed' }));
  }
}

function closeTerminalRuntime(runtime, notifyClients) {
  if (runtime.closeTimer) {
    clearTimeout(runtime.closeTimer);
    runtime.closeTimer = null;
  }
  runtime.closed = true;
  try {
    runtime.shellStream?.end();
  } catch (_error) {
    // Ignore best-effort cleanup failures.
  }
  runtime.shellStream = null;
  try {
    runtime.ssh.end();
  } catch (_error) {
    // Ignore best-effort cleanup failures.
  }
  terminalSessions.delete(runtime.id);

  if (notifyClients) {
    broadcastTerminalSession(runtime, { type: 'closed' });
  }
}

function broadcastTerminalSession(runtime, payload) {
  for (const client of runtime.clients) {
    if (client.readyState === client.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }
}

function sanitizeTerminalRuntimeId(value) {
  const id = String(value || '').trim();
  if (/^[A-Za-z0-9:_-]{1,120}$/.test(id)) {
    return id;
  }
  return uuidv4();
}

function resolveSqlitePath(targetPath) {
  if (path.isAbsolute(targetPath)) {
    return targetPath;
  }
  return path.join(ROOT_DIR, targetPath);
}

function readDurationMs(value, fallbackMs) {
  if (value === undefined || value === null || value === '') {
    return fallbackMs;
  }
  const input = String(value).trim();
  if (/^\d+$/.test(input)) {
    return Number(input);
  }
  const match = input.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
  if (!match) {
    return fallbackMs;
  }
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multipliers = {
    ms: 1,
    s: 1000,
    m: 1000 * 60,
    h: 1000 * 60 * 60,
    d: 1000 * 60 * 60 * 24
  };
  const result = Math.round(amount * multipliers[unit]);
  return Number.isFinite(result) && result > 0 ? result : fallbackMs;
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(number)));
}

function attachWebSocketHeartbeat(ws) {
  if (!WEBSOCKET_PING_INTERVAL_MS) {
    return;
  }
  let alive = true;
  const markAlive = () => {
    alive = true;
  };
  const timer = setInterval(() => {
    if (ws.readyState !== ws.OPEN) {
      clearInterval(timer);
      return;
    }
    if (!alive) {
      ws.terminate();
      clearInterval(timer);
      return;
    }
    alive = false;
    ws.ping();
  }, WEBSOCKET_PING_INTERVAL_MS);

  ws.on('pong', markAlive);
  ws.on('close', () => clearInterval(timer));
  ws.on('error', () => clearInterval(timer));
}

function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(path.dirname(SQLITE_FILE))) {
    fs.mkdirSync(path.dirname(SQLITE_FILE), { recursive: true });
  }

  const db = getSqliteDb();
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SQLITE_KV_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  migrateLegacyStorage();
}

function getSqliteDb() {
  if (!sqliteDb) {
    sqliteDb = new Database(SQLITE_FILE);
  }
  return sqliteDb;
}

function migrateLegacyStorage() {
  if (dbGetRaw(STORAGE_KEYS.state) === null) {
    const legacyState = fs.existsSync(LEGACY_STATE_FILE)
      ? safelyParseJson(fs.readFileSync(LEGACY_STATE_FILE, 'utf8'), defaultState)
      : defaultState;
    dbSetJson(STORAGE_KEYS.state, normalizeStateRecord(legacyState));
  }

  if (dbGetRaw(STORAGE_KEYS.auth) === null) {
    const legacyAuth = fs.existsSync(LEGACY_AUTH_FILE)
      ? safelyParseJson(fs.readFileSync(LEGACY_AUTH_FILE, 'utf8'), getDefaultAuthRecord())
      : getDefaultAuthRecord();
    dbSetJson(STORAGE_KEYS.auth, normalizeAuthRecord(legacyAuth));
  }

  if (dbGetRaw(STORAGE_KEYS.secret) === null) {
    const legacySecret =
      fs.existsSync(LEGACY_SECRET_FILE)
        ? String(fs.readFileSync(LEGACY_SECRET_FILE, 'utf8') || '').trim()
        : '';
    dbSetRaw(STORAGE_KEYS.secret, legacySecret || crypto.randomBytes(32).toString('hex'));
  }

  cachedState = dbGetJson(STORAGE_KEYS.state, defaultState, normalizeStateRecord);
  cachedAuth = dbGetJson(STORAGE_KEYS.auth, getDefaultAuthRecord(), normalizeAuthRecord);
  cachedSecretHex = dbGetRaw(STORAGE_KEYS.secret) || crypto.randomBytes(32).toString('hex');
  if (!dbGetRaw(STORAGE_KEYS.secret)) {
    dbSetRaw(STORAGE_KEYS.secret, cachedSecretHex);
  }
}

function dbGetRaw(key) {
  const row = getSqliteDb()
    .prepare(`SELECT value FROM ${SQLITE_KV_TABLE} WHERE key = ? LIMIT 1`)
    .get(key);
  return row?.value ?? null;
}

function dbSetRaw(key, value) {
  const now = new Date().toISOString();
  getSqliteDb()
    .prepare(`
      INSERT INTO ${SQLITE_KV_TABLE} (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `)
    .run(key, value, now);
}

function dbGetJson(key, fallback, normalizer = (value) => value) {
  const raw = dbGetRaw(key);
  if (raw === null) {
    return normalizer(structuredClone(fallback));
  }
  return normalizer(safelyParseJson(raw, fallback));
}

function dbSetJson(key, value) {
  dbSetRaw(key, JSON.stringify(value));
}

function safelyParseJson(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return structuredClone(fallback);
  }
}

function getDefaultAuthRecord() {
  return {
    configured: false,
    username: '',
    salt: '',
    hash: '',
    updatedAt: ''
  };
}

function normalizeAuthRecord(auth) {
  return {
    configured: Boolean(auth?.configured),
    username: auth?.username || '',
    salt: auth?.salt || '',
    hash: auth?.hash || '',
    updatedAt: auth?.updatedAt || ''
  };
}

function readAuth() {
  ensureStorage();
  if (!cachedAuth) {
    cachedAuth = dbGetJson(STORAGE_KEYS.auth, getDefaultAuthRecord(), normalizeAuthRecord);
  }
  return structuredClone(cachedAuth);
}

function writeAuth(auth) {
  ensureStorage();
  cachedAuth = normalizeAuthRecord(auth);
  dbSetJson(STORAGE_KEYS.auth, cachedAuth);
}

function deriveEncryptionKey(password, salt) {
  return crypto.scryptSync(password, `nurossh:${salt}`, 32);
}

function getAppSecretKey() {
  ensureStorage();
  if (!cachedSecretHex) {
    cachedSecretHex = dbGetRaw(STORAGE_KEYS.secret) || crypto.randomBytes(32).toString('hex');
    dbSetRaw(STORAGE_KEYS.secret, cachedSecretHex);
  }
  return Buffer.from(cachedSecretHex, 'hex');
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

function normalizeStateRecord(parsed) {
  const orchestration = normalizeOrchestrationState(parsed);
  return {
    groups: Array.isArray(parsed?.groups) && parsed.groups.length ? parsed.groups : defaultState.groups,
    servers: Array.isArray(parsed?.servers) ? parsed.servers : [],
    commands: Array.isArray(parsed?.commands) ? parsed.commands : [],
    proxies: Array.isArray(parsed?.proxies) ? parsed.proxies : [],
    automationTasks: Array.isArray(parsed?.automationTasks) ? parsed.automationTasks.map(normalizeAutomationTask) : [],
    automationRuns: Array.isArray(parsed?.automationRuns) ? parsed.automationRuns.slice(0, 30) : [],
    telegram: normalizeTelegramSettings(parsed?.telegram),
    ...orchestration,
    workspaces: parsed?.workspaces && typeof parsed.workspaces === 'object' ? parsed.workspaces : {}
  };
}

function normalizeTelegramSettings(input = {}) {
  return {
    enabled: Boolean(input?.enabled),
    tokenEnc: input?.tokenEnc || null,
    userIds: Array.isArray(input?.userIds)
      ? input.userIds.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 100)
      : [],
    menuScopes: Array.isArray(input?.menuScopes) ? input.menuScopes.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 30) : [],
    allowGroups: input?.allowGroups !== false
  };
}

function normalizeAutomationTask(input = {}, existing = null) {
  const now = new Date().toISOString();
  const steps = Array.isArray(input.steps)
    ? input.steps.map((step, index) => ({
        id: String(step?.id || uuidv4()),
        type: ['command', 'wait', 'input', 'enter', 'delay'].includes(step?.type) ? step.type : 'command',
        label: String(step?.label || '').trim(),
        value: String(step?.value ?? ''),
        inputMode: step?.inputMode === 'per-server' ? 'per-server' : 'broadcast',
        timeout: Math.min(3600, Math.max(1, Number(step?.timeout) || 120)),
        order: index
      }))
    : [];
  return {
    id: existing?.id || input.id || uuidv4(),
    name: String(input.name || '').trim() || '未命名自动化',
    username: String(input.username || 'root').trim() || 'root',
    port: clampPort(input.port),
    passwordEnc: input.passwordEnc || existing?.passwordEnc || null,
    proxyId: String(input.proxyId || '').trim(),
    concurrency: Math.min(300, Math.max(1, Number(input.concurrency) || 100)),
    connectTimeout: Math.min(120, Math.max(3, Number(input.connectTimeout) || 15)),
    stepTimeout: Math.min(3600, Math.max(1, Number(input.stepTimeout) || 120)),
    retryCount: Math.min(5, Math.max(0, Number(input.retryCount) || 0)),
    telegramEnabled: input.telegramEnabled !== false,
    steps,
    createdAt: existing?.createdAt || input.createdAt || now,
    updatedAt: now
  };
}

function sanitizeAutomationTaskForClient(item) {
  const { password, passwordEnc, ...safe } = item || {};
  return safe;
}

function sanitizeTelegramForClient(item) {
  return {
    enabled: Boolean(item?.enabled),
    configured: Boolean(item?.tokenEnc),
    userIds: Array.isArray(item?.userIds) ? item.userIds : [],
    allowGroups: item?.allowGroups !== false
  };
}

function readState() {
  ensureStorage();
  if (!cachedState) {
    cachedState = dbGetJson(STORAGE_KEYS.state, defaultState, normalizeStateRecord);
  }
  return structuredClone(cachedState);
}

function writeState(state) {
  ensureStorage();
  cachedState = normalizeStateRecord(state);
  dbSetJson(STORAGE_KEYS.state, cachedState);
}

function updateState(mutator) {
  const draft = readState();
  const next = mutator(structuredClone(draft));
  writeState(next);
  return readState();
}

function sanitizeStateForClient(state, auth = null) {
  return {
    groups: state.groups,
    commands: state.commands,
    servers: state.servers.map(sanitizeServerForClient),
    proxies: state.proxies.map(sanitizeProxyForClient),
    automationTasks: state.automationTasks.map(sanitizeAutomationTaskForClient),
    automationRuns: state.automationRuns || [],
    telegram: sanitizeTelegramForClient(state.telegram),
    ...sanitizeOrchestrationState(state),
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
    tab: ['commands', 'automation', 'proxies', 'probes', 'pools', 'dns'].includes(source.tab) ? source.tab : 'servers',
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
    tab: ['commands', 'automation', 'proxies', 'probes', 'pools', 'dns'].includes(input.tab) ? input.tab : 'servers',
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
    const serverItem = job.serverById?.get(resultItem.serverId) || readState().servers.find((item) => item.id === resultItem.serverId);
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

function createAutomationJob(task, temporaryServers, command, context = {}) {
  const waitKeywords = task.steps.filter((step) => step.type === 'wait' && step.value.trim()).map((step) => interpolateAutomationValue(step.value.trim(), context));
  const job = createCommandJob(temporaryServers, command, waitKeywords);
  job.type = 'automation';
  job.taskId = task.id;
  job.taskName = task.name;
  job.concurrency = Math.min(300, Math.max(1, Number(task.concurrency) || 100));
  job.serverById = new Map(temporaryServers.map((item) => [item.id, item]));
  job.automationSteps = task.steps;
  job.retryCount = task.retryCount;
  job.stepTimeout = task.stepTimeout;
  job.automationResponders = [];
  task.steps.forEach((step, index) => {
    if (step.type !== 'wait' || !step.value.trim()) return;
    const next = task.steps[index + 1];
    if (next?.type === 'input' || next?.type === 'enter') {
      job.automationResponders.push({
        waitText: interpolateAutomationValue(step.value.trim(), context),
        input: next.type === 'enter' ? '' : interpolateAutomationValue(next.value, context),
        inputMode: next.type === 'input' && next.inputMode === 'per-server' ? 'per-server' : 'broadcast'
      });
    }
  });
  job.automationInterval = null;
  job.paused = false;
  job.runRecorded = false;
  return job;
}

function startAutomationTask(task, hosts, state, encryptionKeyHex) {
  return startAutomationTaskWithContext(task, hosts, state, encryptionKeyHex, {});
}

function startAutomationTaskWithContext(task, hosts, state, encryptionKeyHex, context = {}) {
  const password = getStoredSecretValue(task, encryptionKeyHex);
  const temporaryServers = hosts.map((host) => ({
    id: uuidv4(), name: host, host, port: task.port, username: task.username,
    passwordEnc: encryptSecret(password), proxyId: task.proxyId, connectTimeout: task.connectTimeout
  }));
  const command = task.steps
    .flatMap((step) => {
      if (step.type === 'command' && step.value.trim()) return [interpolateAutomationValue(step.value.trim(), context)];
      if (step.type === 'delay') {
        const seconds = Math.min(3600, Math.max(0, Number(step.value) || 0));
        return seconds ? [`sleep ${Math.floor(seconds)}`] : [];
      }
      return [];
    })
    .join('\n');
  const job = createAutomationJob(task, temporaryServers, command, context);
  commandJobs.set(job.id, job);
  updateState((draft) => {
    draft.automationRuns = [{ id: job.id, taskId: task.id, taskName: task.name, total: hosts.length, ok: 0, error: 0, status: 'running', startedAt: job.startedAt, finishedAt: '' }, ...(draft.automationRuns || [])].slice(0, 30);
    return draft;
  });
  runAutomationJob(job, state.proxies, encryptionKeyHex);
  return job;
}

function interpolateAutomationValue(value, context = {}) {
  return String(value || '').replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(context, key)) return match;
    return String(context[key] ?? '');
  });
}

function executeAutomationForIncident(taskId, hosts, context, encryptionKey) {
  const state = readState();
  const task = state.automationTasks.find((item) => item.id === taskId);
  if (!task) throw new Error('关联的自动化任务不存在');
  const job = startAutomationTaskWithContext(task, hosts, state, encryptionKey, context);
  return { jobId: job.id, results: job.results };
}

function waitForAutomationJob(jobId, timeoutSeconds = 1800) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const job = commandJobs.get(jobId);
      if (!job) {
        clearInterval(timer);
        reject(new Error('自动化任务执行记录已过期'));
        return;
      }
      if (job.results.every((item) => ['done', 'error'].includes(item.status))) {
        clearInterval(timer);
        const failed = job.results.filter((item) => item.status === 'error' || !item.ok);
        if (failed.length) reject(new Error(`自动化任务有 ${failed.length} 台执行失败`));
        else resolve(job.results);
        return;
      }
      if (Date.now() - startedAt > timeoutSeconds * 1000) {
        clearInterval(timer);
        cancelCommandJob(job);
        reject(new Error('自动化任务等待超时'));
      }
    }, 500);
  });
}

function notifyIncidentViaTelegram(incidentId) {
  const state = readState();
  const incident = state.incidents?.find((item) => item.id === incidentId);
  if (!incident) return;
  const configs = [];
  if (state.telegram?.enabled && state.telegram?.tokenEnc) configs.push({ ...state.telegram, id: 'legacy' });
  for (const bot of state.telegramBots || []) if (bot.enabled && bot.tokenEnc) configs.push(bot);
  const text = `故障事件：${incident.targetName}\n状态：${incident.status}\n${incident.message || incident.error || ''}`;
  for (const settings of configs) {
    let token = '';
    try { token = decryptSecret(settings.tokenEnc); } catch (_error) { continue; }
    for (const chatId of [...new Set([...(settings.userIds || []), ...(settings.groupIds || [])])]) {
      telegramCall(token, 'sendMessage', { chat_id: chatId, text }).catch(() => {});
    }
  }
}

function runAutomationJob(job, proxies, encryptionKeyHex) {
  let active = 0;
  let cursor = 0;
  const startMore = () => {
    if (job.cancelled || job.paused) return;
    while (active < job.concurrency && cursor < job.results.length) {
      const resultItem = job.results[cursor++];
      const serverItem = job.serverById.get(resultItem.serverId);
      active += 1;
      resultItem.status = 'running';
      startInteractiveCommandSession(job, resultItem, serverItem, proxies, encryptionKeyHex);
    }
  };
  job.automationInterval = setInterval(() => {
    active = job.results.filter((item) => ['running', 'awaiting_input'].includes(item.status)).length;
    startMore();
    if (cursor >= job.results.length && job.results.every((item) => ['done', 'error'].includes(item.status))) {
      clearInterval(job.automationInterval);
      job.automationInterval = null;
      refreshCommandJobStatus(job);
      recordAutomationRun(job);
    }
  }, 300);
  startMore();
}

function recordAutomationRun(job) {
  if (job.runRecorded) return;
  job.runRecorded = true;
  updateState((draft) => {
    const record = (draft.automationRuns || []).find((item) => item.id === job.id);
    if (record) Object.assign(record, { ok: job.results.filter((item) => item.ok).length, error: job.results.filter((item) => item.status === 'error').length, status: job.cancelled ? 'cancelled' : 'done', finishedAt: job.finishedAt || new Date().toISOString() });
    return draft;
  });
}

function telegramAuthorized(settings, from, chat) {
  const userId = String(from?.id || '');
  if (!settings?.enabled || !(settings?.tokenEnc || settings?.configured) || !settings.userIds?.includes(userId)) return false;
  if ((chat?.type === 'group' || chat?.type === 'supergroup') && settings.groupIds?.length && !settings.groupIds.includes(String(chat.id))) return false;
  if (chat?.type === 'group' || chat?.type === 'supergroup') return settings.allowGroups !== false;
  return true;
}

function telegramMenuAllowed(settings, scope) {
  const scopes = Array.isArray(settings?.menuScopes) ? settings.menuScopes : [];
  return !scopes.length || scopes.includes(scope);
}

function telegramPendingIsFresh(pending) {
  return pending && Number(pending.expiresAt || 0) > Date.now();
}

function telegramApiUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function telegramCall(token, method, body = {}) {
  const response = await fetch(telegramApiUrl(token, method), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(payload.description || 'Telegram API error');
  return payload.result;
}

function telegramButtons(tasks, prefix) {
  return tasks.slice(0, 20).map((task) => ([{ text: task.name, callback_data: `${prefix}:${task.id}` }]));
}

function telegramSessionKey(chat, from) {
  return `${String(chat?.id || '')}:${String(from?.id || '')}`;
}

async function handleTelegramUpdate(update, token, botSettings = null) {
  const state = readState();
  const settings = botSettings || state.telegram;
  const message = update.message;
  const callback = update.callback_query;
  const from = message?.from || callback?.from;
  const chat = message?.chat || callback?.message?.chat;
  if (!telegramAuthorized(settings, from, chat)) return;
  const chatId = chat.id;
  const sessionKey = telegramSessionKey(chat, from);
  if (callback) {
    await telegramCall(token, 'answerCallbackQuery', { callback_query_id: callback.id });
    const [action, value] = String(callback.data || '').split(':');
    const pending = telegramRuntime.pending.get(sessionKey);
    if (pending && !telegramPendingIsFresh(pending)) telegramRuntime.pending.delete(sessionKey);
    if (action === 'menu') {
      if (value === 'root') return sendTelegramMenu(token, chatId, settings);
      if (!telegramMenuAllowed(settings, value)) return;
      if (value === 'overview') return telegramCall(token, 'sendMessage', { chat_id: chatId, text: telegramOverview(state), reply_markup: telegramOverviewButtons() });
      if (value === 'incidents') return sendTelegramIncidents(token, chatId, state);
      if (value === 'probes') return sendTelegramProbes(token, chatId, state);
      if (value === 'pools') return sendTelegramPools(token, chatId, state);
      if (value === 'dns') return sendTelegramDns(token, chatId, state);
      if (value === 'automation') return telegramCall(token, 'sendMessage', { chat_id: chatId, text: '选择一个自动化任务：', reply_markup: { inline_keyboard: telegramButtons(state.automationTasks.filter((item) => item.telegramEnabled !== false), 'task') } });
    }
    if (action === 'incident') {
      if (!telegramMenuAllowed(settings, 'incidents')) return;
      const incident = state.incidents?.find((item) => item.id === value);
      if (!incident) return;
      const canExecute = ['pending_approval', 'failed', 'observing'].includes(incident.status);
      return telegramCall(token, 'sendMessage', { chat_id: chatId, text: `故障事件：${incident.targetName}\n状态：${STATUS_LABELS[incident.status] || incident.status}\n${incident.message || incident.error || ''}\n备用 IP：${incident.allocatedIps?.join(', ') || '尚未分配'}`, reply_markup: { inline_keyboard: [canExecute ? [{ text: '确认执行', callback_data: `incident_execute:${incident.id}` }] : [], incident.dnsChangeIds?.length ? [{ text: '回滚', callback_data: `incident_rollback:${incident.id}` }] : [], [{ text: '返回事件', callback_data: 'menu:incidents' }]].filter((row) => row.length) } });
    }
    if (action === 'incident_execute') {
      if (!telegramMenuAllowed(settings, 'incidents')) return;
      if (!['owner', 'admin', 'operator', 'approver'].includes(resolveTelegramRole(state, settings, from, chat))) return;
      const incident = state.incidents?.find((item) => item.id === value);
      if (!incident || !['pending_approval', 'failed', 'observing'].includes(incident.status)) return;
      if (!updateIncidentFromTelegram(value, 'queued', `Telegram ${from.id} 确认执行`)) return;
      orchestrationDeps.runIncident(value);
      return telegramCall(token, 'sendMessage', { chat_id: chatId, text: '已确认，故障编排开始执行。' });
    }
    if (action === 'incident_rollback') {
      if (!telegramMenuAllowed(settings, 'incidents')) return;
      if (!['owner', 'admin', 'operator', 'approver'].includes(resolveTelegramRole(state, settings, from, chat))) return;
      await rollbackIncidentFromTelegram(value);
      return telegramCall(token, 'sendMessage', { chat_id: chatId, text: '已开始回滚。' });
    }
    if (action === 'task') {
      if (!telegramMenuAllowed(settings, 'automation')) return;
      const task = state.automationTasks.find((item) => item.id === value && item.telegramEnabled !== false);
      if (!task) return;
      telegramRuntime.pending.set(sessionKey, { taskId: task.id, hosts: '', awaitingHosts: true, messageId: callback.message.message_id, expiresAt: Date.now() + 10 * 60 * 1000 });
      await telegramCall(token, 'sendMessage', { chat_id: chatId, text: `已选择：${task.name}\n请发送 IP 列表，每行一个。` });
      return;
    }
    if (action === 'confirm' && pending?.hosts) {
      if (!telegramMenuAllowed(settings, 'automation')) return;
      const task = state.automationTasks.find((item) => item.id === pending.taskId);
      if (!task) return;
      const job = startAutomationTask(task, pending.hosts, state, undefined);
      telegramRuntime.pending.delete(sessionKey);
      const sent = await telegramCall(token, 'sendMessage', { chat_id: chatId, text: `已启动：${task.name}\n总数：${job.results.length}\n并发：${job.concurrency}`, reply_markup: { inline_keyboard: [[{ text: '取消任务', callback_data: `canceljob:${job.id}` }]] } });
      scheduleTelegramProgress(chatId, sent.message_id, job.id, token);
      return;
    }
    if (action === 'canceljob') {
      if (!telegramMenuAllowed(settings, 'automation')) return;
      const job = commandJobs.get(value);
      if (job?.type === 'automation') cancelCommandJob(job);
      await telegramCall(token, 'sendMessage', { chat_id: chatId, text: job ? '任务已取消。' : '任务已结束或过期。' });
      return;
    }
    if (action === 'cancel') { telegramRuntime.pending.delete(sessionKey); await telegramCall(token, 'sendMessage', { chat_id: chatId, text: '已取消。' }); }
    return;
  }
  const text = String(message?.text || '').trim();
  if (/^\/(?:start|menu)(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text) || text === '菜单') {
    await sendTelegramMenu(token, chatId, settings);
    return;
  }
  if (/^\/(?:run)(?:@[A-Za-z0-9_]+)?(?:\s|$)/.test(text) || text === '执行自动化') {
    if (!telegramMenuAllowed(settings, 'automation')) return;
    await telegramCall(token, 'sendMessage', { chat_id: chatId, text: '选择一个自动化任务：', reply_markup: { inline_keyboard: telegramButtons(state.automationTasks.filter((item) => item.telegramEnabled !== false), 'task') } });
    return;
  }
  if (text === '/status' || text === '总览') {
    if (!telegramMenuAllowed(settings, 'overview')) return;
    await telegramCall(token, 'sendMessage', { chat_id: chatId, text: telegramOverview(state), reply_markup: telegramOverviewButtons() });
    return;
  }
  if (text === '/incidents' || text === '故障事件') {
    if (!telegramMenuAllowed(settings, 'incidents')) return;
    await sendTelegramIncidents(token, chatId, state);
    return;
  }
  if (text === '/probes' || text === '探针管理') {
    if (!telegramMenuAllowed(settings, 'probes')) return;
    await sendTelegramProbes(token, chatId, state);
    return;
  }
  if (text === '/pools' || text === '备用 IP 池') {
    if (!telegramMenuAllowed(settings, 'pools')) return;
    await sendTelegramPools(token, chatId, state);
    return;
  }
  if (text === '/dns' || text === '解析管理') {
    if (!telegramMenuAllowed(settings, 'dns')) return;
    await sendTelegramDns(token, chatId, state);
    return;
  }
  const pending = telegramRuntime.pending.get(sessionKey);
  if (pending && !telegramPendingIsFresh(pending)) {
    telegramRuntime.pending.delete(sessionKey);
    return;
  }
  if (pending?.awaitingHosts && text) {
    const hosts = [...new Set(text.split(/[\s,，;；]+/).filter(Boolean))].slice(0, 5000);
    pending.hosts = hosts; pending.awaitingHosts = false;
    telegramRuntime.pending.set(sessionKey, pending);
    await telegramCall(token, 'sendMessage', { chat_id: chatId, text: `已接收 ${hosts.length} 个地址，确认执行？`, reply_markup: { inline_keyboard: [[{ text: '确认执行', callback_data: 'confirm:yes' }, { text: '取消', callback_data: 'cancel:no' }]] } });
  }
}

async function sendTelegramMenu(token, chatId, settings) {
  const button = (scope, text, callback) => telegramMenuAllowed(settings, scope) ? { text, callback_data: callback } : null;
  const rows = [
    [button('overview', '总览', 'menu:overview'), button('incidents', '故障事件', 'menu:incidents')],
    [button('probes', '探针管理', 'menu:probes'), button('pools', '备用 IP 池', 'menu:pools')],
    [button('dns', '解析管理', 'menu:dns'), button('automation', '自动化任务', 'menu:automation')]
  ].map((row) => row.filter(Boolean)).filter((row) => row.length);
  await telegramCall(token, 'sendMessage', {
    chat_id: chatId,
    text: 'NuroSSH 操作菜单',
    reply_markup: { inline_keyboard: rows }
  });
}

function telegramOverview(state) {
  const activeIncidents = (state.incidents || []).filter((item) => !['succeeded', 'rolled_back'].includes(item.status)).length;
  const onlineProbes = (state.probes || []).filter((item) => item.status === 'online').length;
  const availableIps = (state.ipAssets || []).filter((item) => item.enabled !== false && item.health !== 'unhealthy').length;
  return `系统总览\n在线探针：${onlineProbes}\n活动故障：${activeIncidents}\nIP 资产：${state.ipAssets?.length || 0}\n可用 IP：${availableIps}\nDNS 绑定：${state.dnsBindings?.length || 0}`;
}

function telegramOverviewButtons() {
  return { inline_keyboard: [[{ text: '刷新', callback_data: 'menu:overview' }, { text: '打开菜单', callback_data: 'menu:root' }]] };
}

async function sendTelegramIncidents(token, chatId, state) {
  const incidents = (state.incidents || []).slice(0, 12);
  const text = incidents.length ? `故障事件（${incidents.length}）\n` + incidents.map((item, index) => `${index + 1}. ${item.targetName} · ${STATUS_LABELS[item.status] || item.status}`).join('\n') : '当前没有故障事件';
  const buttons = incidents.map((item) => ([{ text: `${item.targetName} · ${STATUS_LABELS[item.status] || item.status}`, callback_data: `incident:${item.id}` }]));
  await telegramCall(token, 'sendMessage', { chat_id: chatId, text, reply_markup: { inline_keyboard: [...buttons, [{ text: '返回菜单', callback_data: 'menu:root' }]] } });
}

async function sendTelegramProbes(token, chatId, state) {
  const probes = (state.probes || []).slice(0, 20);
  const text = probes.length ? `探针节点\n${probes.map((item) => `${item.name} · ${STATUS_LABELS[item.status] || item.status} · ${item.region || '未设置地区'}`).join('\n')}` : '当前没有探针节点';
  await telegramCall(token, 'sendMessage', { chat_id: chatId, text, reply_markup: { inline_keyboard: [[{ text: '刷新', callback_data: 'menu:probes' }, { text: '返回菜单', callback_data: 'menu:root' }]] } });
}

async function sendTelegramPools(token, chatId, state) {
  const pools = (state.ipPools || []).slice(0, 20);
  const text = pools.length ? `备用 IP 池\n${pools.map((item) => `${item.name} · ${item.assetIds?.length || 0} 个 IP · ${item.allocationMode === 'all' ? '全部取用' : item.allocationMode === 'count' ? `取 ${item.allocationCount} 个` : '取一个'}`).join('\n')}` : '当前没有备用 IP 池';
  await telegramCall(token, 'sendMessage', { chat_id: chatId, text, reply_markup: { inline_keyboard: [[{ text: '刷新', callback_data: 'menu:pools' }, { text: '返回菜单', callback_data: 'menu:root' }]] } });
}

async function sendTelegramDns(token, chatId, state) {
  const bindings = (state.dnsBindings || []).slice(0, 20);
  const text = bindings.length ? `解析绑定\n${bindings.map((item) => `${item.name} · ${item.domain} · ${item.recordType}`).join('\n')}` : '当前没有解析绑定';
  await telegramCall(token, 'sendMessage', { chat_id: chatId, text, reply_markup: { inline_keyboard: [[{ text: '刷新', callback_data: 'menu:dns' }, { text: '返回菜单', callback_data: 'menu:root' }]] } });
}

const STATUS_LABELS = { online: '在线', pending: '待接入', revoked: '已吊销', healthy: '正常', down: '故障', observing: '观察中', pending_approval: '待确认', queued: '等待执行', allocating: '分配 IP', automating: '执行任务', dns_updating: '更新 DNS', verifying: '验证中', succeeded: '已完成', failed: '失败', rolled_back: '已回滚' };

function resolveTelegramRole(state, settings, from, chat) {
  const userId = String(from?.id || '');
  const botRole = settings.roles?.[userId];
  const globalIds = state.telegram?.userIds || [];
  if (botRole) return botRole;
  if (globalIds.includes(userId)) return 'operator';
  if (chat && settings.roles?.[String(chat.id)]) return settings.roles[String(chat.id)];
  return 'viewer';
}

function updateIncidentFromTelegram(id, status, message) {
  let updated = false;
  orchestrationDeps.updateState((draft) => {
    const incident = draft.incidents.find((item) => item.id === id);
    if (incident && ['pending_approval', 'failed', 'observing'].includes(incident.status)) {
      Object.assign(incident, { status, message, updatedAt: new Date().toISOString() });
      updated = true;
    }
    return draft;
  });
  return updated;
}

async function rollbackIncidentFromTelegram(id) {
  return rollbackIncident(id, orchestrationDeps, 'telegram');
}

function scheduleTelegramProgress(chatId, messageId, jobId, token) {
  const key = `${chatId}:${messageId}`;
  if (telegramRuntime.progressTimers.has(key)) clearInterval(telegramRuntime.progressTimers.get(key));
  const timer = setInterval(async () => {
    const job = commandJobs.get(jobId);
    if (!job) { clearInterval(timer); telegramRuntime.progressTimers.delete(key); return; }
    const counts = { total: job.results.length, ok: job.results.filter((item) => item.ok).length, error: job.results.filter((item) => item.status === 'error').length, running: job.results.filter((item) => ['queued', 'running', 'awaiting_input'].includes(item.status)).length };
    const title = job.status === 'done' ? (job.cancelled ? '自动化已取消' : '自动化已完成') : '自动化执行中';
    const text = `${title}\n总数：${counts.total}\n成功：${counts.ok}\n失败：${counts.error}\n执行中：${counts.running}`;
    try { await telegramCall(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text, reply_markup: job.status === 'done' ? { inline_keyboard: [] } : { inline_keyboard: [[{ text: '取消任务', callback_data: `canceljob:${job.id}` }]] } }); } catch (_error) { /* stale message */ }
    if (job.status === 'done') { clearInterval(timer); telegramRuntime.progressTimers.delete(key); }
  }, 2500);
  telegramRuntime.progressTimers.set(key, timer);
}

function restartTelegramPolling() {
  telegramRuntime.generation += 1;
  const generation = telegramRuntime.generation;
  if (telegramRuntime.timer) { clearTimeout(telegramRuntime.timer); telegramRuntime.timer = null; }
  const state = readState();
  const botConfigs = [];
  if (state.telegram?.enabled && state.telegram?.tokenEnc) botConfigs.push({ id: 'legacy', ...state.telegram });
  for (const bot of state.telegramBots || []) if (bot.enabled && bot.tokenEnc) botConfigs.push(bot);
  if (!botConfigs.length) return;
  const poll = async () => {
    await Promise.all(botConfigs.map(async (settings) => {
      let token = '';
      try { token = decryptSecret(settings.tokenEnc); } catch (_error) { return; }
      const offset = telegramRuntime.offsets.get(settings.id) || 0;
      try {
        const updates = await telegramCall(token, 'getUpdates', { offset, timeout: 4, allowed_updates: ['message', 'callback_query'] });
        for (const update of updates) {
          telegramRuntime.offsets.set(settings.id, update.update_id + 1);
          await handleTelegramUpdate(update, token, settings);
        }
      } catch (_error) { /* retry below */ }
    }));
    if (generation === telegramRuntime.generation) telegramRuntime.timer = setTimeout(poll, 1000);
  };
  poll();
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
    executionTimer: null,
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
    if (runtime.executionTimer) {
      clearTimeout(runtime.executionTimer);
      runtime.executionTimer = null;
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

  runtime.stepTimeout = Math.min(3600, Math.max(1, Number(job.stepTimeout) || 120));
  resultItem.retryAttempt = Number(resultItem.retryAttempt) || 0;

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
          if (job.type === 'automation') {
            runtime.executionTimer = setTimeout(() => {
              if (!['done', 'error'].includes(resultItem.status)) {
                markRuntimeError(`执行超时（${runtime.stepTimeout} 秒）`);
                finalizeRuntime();
              }
            }, runtime.stepTimeout * 1000);
          }
          scheduleAwaitingInputCheck(job, runtime, resultItem);
        }, 120);
      }
    );
  });

  ssh.on('error', (error) => {
    if (job.type === 'automation' && resultItem.retryAttempt < (Number(job.retryCount) || 0) && !job.cancelled) {
      resultItem.retryAttempt += 1;
      resultItem.status = 'running';
      runtime.closed = true;
      try { ssh.end(); } catch (_error) { /* best effort */ }
      setTimeout(() => startInteractiveCommandSession(job, resultItem, serverItem, proxies, encryptionKeyHex), 600 * resultItem.retryAttempt);
      return;
    }
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

  if (job.type === 'automation' && runtime.shellStream && !runtime.closed) {
    const responderIndex = Number(runtime.automationResponderIndex) || 0;
    const responder = job.automationResponders?.[responderIndex];
    if (responder && runtime.tailText.toLowerCase().includes(responder.waitText.toLowerCase())) {
      runtime.automationResponderIndex = responderIndex + 1;
      runtime.tailText = '';
      if (responder.inputMode === 'per-server') {
        resultItem.status = 'awaiting_input';
        resultItem.awaitingInput = true;
        resultItem.inputRequestCount += 1;
        runtime.awaitingAutomationResponder = responder;
        broadcastCommandSession(runtime, { type: 'state', status: resultItem.status, awaitingInput: true, inputMode: 'per-server' });
        refreshCommandJobStatus(job);
      } else {
        writeCommandSessionInput(job, runtime, resultItem, normalizeCommandInput(responder.input));
      }
    }
  }

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
  if (job.type === 'automation') recordAutomationRun(job);
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
  if (runtime?.executionTimer) {
    clearTimeout(runtime.executionTimer);
    runtime.executionTimer = null;
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

function findGroupByName(state, name) {
  const normalizedName = String(name || '').trim();
  if (!normalizedName) {
    return null;
  }
  return state.groups.find((group) => group.name === normalizedName) || null;
}

function ensureUniqueGroupName(state, name, ignoredId = '') {
  const existingGroup = findGroupByName(state, name);
  if (existingGroup && existingGroup.id !== ignoredId) {
    throw new Error('分组名称已存在');
  }
}

function ensureGroupByNameOrId(state, groupName, groupId) {
  const nextName = String(groupName || '').trim();
  if (nextName) {
    const existingByName = findGroupByName(state, nextName);
    if (existingByName) {
      return existingByName.id;
    }

    const group = normalizeGroup({ name: nextName });
    state.groups.push(group);
    return group.id;
  }

  const existingById = state.groups.find((group) => group.id === groupId);
  return existingById ? existingById.id : 'group-default';
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
    readyTimeout: Math.min(120000, Math.max(3000, Number(serverItem.connectTimeout) * 1000 || 15000)),
    keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
    keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
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
      const options = buildConnectOptions(serverItem, serverPassword);
      ssh.connect(socket ? { ...options, sock: socket } : options);
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
