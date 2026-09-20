import assert from 'node:assert/strict';
import test from 'node:test';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createSessionSocketRegistry, createWebSocketTickets, createWebSocketUpgradeHandler } from '../server/websocket-security.js';

// Exercise the real ws handshake/parser without opening a port or an SSH connection.
class MemorySocket extends Duplex {
  output = [];
  _read() {}
  _write(chunk, _encoding, done) { this.output.push(Buffer.from(chunk)); done(); }
  setTimeout() {}
  setNoDelay() {}
}
function maskedText(text) {
  const data = Buffer.from(text), mask = Buffer.from([1, 2, 3, 4]);
  return Buffer.concat([Buffer.from([0x81, 0x80 | data.length]), mask, Buffer.from(data.map((value, i) => value ^ mask[i % 4]))]);
}

test('ws library upgrades proxy requests and exchanges frames for both paths; logout closes both sockets', async (t) => {
  const session = { token: 'synthetic-session', expiresAt: Date.now() + 60000 };
  const sessions = new Map([[session.token, session]]);
  const registry = createSessionSocketRegistry(sessions), tickets = createWebSocketTickets(sessions);
  const getSession = (req) => req.headers.cookie === `nurossh_session=${session.token}` ? sessions.get(session.token) : null;
  const wss = new WebSocketServer({ noServer: true });
  t.after(() => { for (const client of wss.clients) client.terminate(); wss.close(); });
  const upgrade = createWebSocketUpgradeHandler({ wss, getSession, sessionSockets: registry, tickets });
  const clients = [];
  for (const path of ['/ws/terminal', '/ws/command-job']) {
    const tcp = new MemorySocket();
    const req = { method: 'GET', url: path, socket: tcp, headers: {
      host: '127.0.0.1:38471', origin: 'https://panel.example:8443', cookie: `nurossh_session=${session.token}`,
      'sec-fetch-site': 'same-origin', 'x-nurossh-websocket': '1', upgrade: 'websocket', connection: 'Upgrade',
      'sec-websocket-version': '13', 'sec-websocket-key': Buffer.alloc(16, 1).toString('base64')
    } };
    const ticket = tickets.issue(req, session, path);
    req.headers['sec-websocket-protocol'] = `nurossh-v1, nurossh-ticket.${ticket}`;
    const connected = once(wss, 'connection');
    upgrade(req, tcp, Buffer.alloc(0));
    const [ws] = await connected; clients.push(ws);
    assert.equal(ws.protocol, 'nurossh-v1');
    assert.match(Buffer.concat(tcp.output).toString(), /^HTTP\/1.1 101 Switching Protocols/);
    assert.ok(!Buffer.concat(tcp.output).toString().includes(ticket), 'proof is not returned as selected protocol');
    const received = once(ws, 'message'); tcp.push(maskedText('terminal-input'));
    assert.equal(String((await received)[0]), 'terminal-input');
    const previous = tcp.output.length;
    await new Promise((resolve, reject) => ws.send('terminal-output', (error) => error ? reject(error) : resolve()));
    assert.equal(Buffer.concat(tcp.output.slice(previous)).subarray(2).toString(), 'terminal-output');
  }
  const closed = clients.map((ws) => once(ws, 'close'));
  registry.revoke(session.token);
  await Promise.all(closed);
  assert.ok(clients.every((ws) => ws.readyState === ws.CLOSED));
});
