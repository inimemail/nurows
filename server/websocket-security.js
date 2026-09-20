import { randomBytes } from 'node:crypto';

const socketPaths = new Set(['/ws/terminal', '/ws/command-job']);

export function isAllowedWebSocketOrigin(req, { allowedOrigins = [], production = true, devPort = '5173' } = {}) {
  try {
    const raw = req.headers.origin;
    if (typeof raw !== 'string' || raw === 'null') return false;
    const origin = new URL(raw);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== raw) return false;
    if (allowedOrigins.includes(origin.origin)) return true;
    if (!production && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) && origin.port === String(devPort)) return true;
    // Reverse proxies must preserve Host and overwrite X-Forwarded-Proto.
    // Never use arbitrary X-Forwarded-Host as an origin allowlist.
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = req.socket?.encrypted || forwardedProto === 'https' ? 'https:' : 'http:';
    const host = req.headers.host;
    if (typeof host !== 'string' || !host || /[\s/@?#\\]/.test(host)) return false;
    return origin.origin === new URL(`${protocol}//${host}`).origin;
  } catch { return false; }
}

export function createSessionSocketRegistry(sessions, now = Date.now) {
  const byToken = new Map();
  const bindings = new WeakMap();
  const detach = (ws) => {
    const session = bindings.get(ws);
    if (!session) return;
    bindings.delete(ws);
    const clients = byToken.get(session.token);
    clients?.delete(ws);
    if (!clients?.size) byToken.delete(session.token);
  };
  const disconnect = (ws) => { detach(ws); try { ws.terminate(); } catch {} };
  const valid = (session) => Boolean(session && sessions.get(session.token) === session && session.expiresAt > now());
  return {
    bind(ws, session) {
      if (!valid(session)) { disconnect(ws); return false; }
      bindings.set(ws, session);
      if (!byToken.has(session.token)) byToken.set(session.token, new Set());
      byToken.get(session.token).add(ws);
      ws.once('close', () => detach(ws));
      ws.once('error', () => detach(ws));
      return true;
    },
    authorized(ws) {
      if (valid(bindings.get(ws))) return true;
      disconnect(ws);
      return false;
    },
    revoke(token) {
      sessions.delete(token);
      for (const ws of [...(byToken.get(token) || [])]) disconnect(ws);
    },
    revokeAll() {
      sessions.clear();
      for (const clients of [...byToken.values()]) for (const ws of [...clients]) disconnect(ws);
    }
  };
}

export function createWebSocketUpgradeHandler({ wss, getSession, sessionSockets, originOptions, tickets }) {
  return (req, socket, head) => {
    const reject = (status) => {
      try { socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch {}
      socket.destroy();
    };
    try {
      const url = new URL(req.url || '', 'http://localhost');
      if (!socketPaths.has(url.pathname)) { reject('404 Not Found'); return; }
      const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map((value) => value.trim());
      const proof = protocols.find((value) => value.startsWith('nurossh-ticket.'));
      if (!proof && !isAllowedWebSocketOrigin(req, originOptions)) { reject('403 Forbidden'); return; }
      const session = getSession(req);
      if (!session) { reject('401 Unauthorized'); return; }
      if (proof && !tickets?.consume(proof.slice('nurossh-ticket.'.length), req, session, url.pathname)) { reject('403 Forbidden'); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        // A session may be revoked between accepting and completing a handshake.
        if (sessionSockets.bind(ws, session)) wss.emit('connection', ws, req);
      });
    } catch { reject('400 Bad Request'); }
  };
}
// A same-origin authenticated HTTP request proves the browser's public origin,
// even when a TLS-terminating proxy rewrites the upstream Host or protocol.
export function createWebSocketTickets(sessions, { now = Date.now, ttl = 30000, limit = 4096 } = {}) {
  const tickets = new Map();
  function cleanup() {
    for (const [token, entry] of tickets) {
      if (entry.expiresAt > now()) break;
      tickets.delete(token);
    }
  }
  return {
    cleanup,
    issue(req, session, path, originOptions) {
      const site = req.headers['sec-fetch-site'];
      const origin = req.headers.origin;
      let validOrigin = false;
      try { const parsed = new URL(origin); validOrigin = ['https:', 'http:'].includes(parsed.protocol) && parsed.origin === origin; } catch {}
      if (!session || sessions.get(session.token) !== session || session.expiresAt <= now()) throw Object.assign(new Error('登录已失效，请重新登录'), { statusCode: 401 });
      if (!socketPaths.has(path) || !validOrigin || req.headers['x-nurossh-websocket'] !== '1'
        || (site ? site !== 'same-origin' : !isAllowedWebSocketOrigin(req, originOptions))) {
        throw Object.assign(new Error('终端连接来源校验失败，请从面板页面重试'), { statusCode: 403 });
      }
      cleanup();
      while (tickets.size >= limit) tickets.delete(tickets.keys().next().value);
      const ticket = randomBytes(32).toString('hex');
      tickets.set(ticket, { session, path, origin, expiresAt: now() + ttl });
      return ticket;
    },
    consume(ticket, req, session, path) {
      const entry = tickets.get(ticket);
      tickets.delete(ticket);
      return Boolean(entry && entry.expiresAt > now() && entry.session === session
        && sessions.get(session.token) === session && session.expiresAt > now()
        && entry.path === path && entry.origin === req.headers.origin);
    }
  };
}
