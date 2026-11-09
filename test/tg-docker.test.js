import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createTgDockerClient } from '../shared/tg-docker.js';
import { requestTgJson } from '../shared/tg-http.js';

async function fixture(t, handler) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tg-docker-'));
  const socketPath = path.join(root, 'd');
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    calls.push({ method: req.method, url: req.url, body });
    const result = handler(req, body) || {};
    res.writeHead(result.status || 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.data || {}));
  });
  server.listen(socketPath);
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, socketPath, calls, docker: createTgDockerClient(socketPath) };
}

test('Docker negotiation supports old and new minimum versions and caches concurrent discovery', async t => {
  for (const [minimum, maximum, selected] of [['1.24', '1.41', '1.41'], ['1.40', '1.56', '1.41'], ['1.44', '1.52', '1.44'], ['1.9', '1.100', '1.41'], [undefined, '1.43', '1.41']]) {
    const { docker, calls } = await fixture(t, req => req.url === '/version'
      ? { data: { ApiVersion: maximum, ...(minimum && { MinAPIVersion: minimum }) } }
      : { data: { ok: true } });
    assert.deepEqual(await Promise.all([docker('GET', '/info'), docker('GET', '/containers/json')]), [{ ok: true }, { ok: true }]);
    await docker('POST', '/containers/create', { Image: 'fixture', HostConfig: { Memory: 1024 ** 3 } });
    assert.deepEqual(calls.map(call => call.url), ['/version', `/v${selected}/info`, `/v${selected}/containers/json`, `/v${selected}/containers/create`]);
    assert.equal(calls.at(-1).body.HostConfig.Memory, 1024 ** 3);
  }
});

test('Docker rejects invalid/unsupported version ranges before any mutation', async t => {
  for (const data of [{ ApiVersion: '1.40' }, {}, { ApiVersion: 'garbage' }, { ApiVersion: '1.52', MinAPIVersion: '1.53' }, { ApiVersion: '1.52', MinAPIVersion: '../info' }]) {
    const { docker, calls } = await fixture(t, () => ({ data }));
    await assert.rejects(docker('POST', '/containers/create', { Image: 'fixture' }), /API|版本/);
    assert.deepEqual(calls.map(call => call.url), ['/version']);
  }
});

test('failed Docker discovery is retried on the next call and preserves the daemon rejection', async t => {
  let broken = true;
  const { docker, calls } = await fixture(t, req => req.url === '/version'
    ? broken ? { status: 403, data: { message: 'authorization denied' } } : { data: { ApiVersion: '1.52', MinAPIVersion: '1.44' } }
    : { data: { ok: true } });
  await assert.rejects(docker('GET', '/info'), error => error.dockerStatus === 403 && /authorization denied/.test(error.message));
  broken = false;
  assert.deepEqual(await docker('GET', '/info'), { ok: true });
  assert.deepEqual(calls.map(call => call.url), ['/version', '/version', '/v1.44/info']);
});

test('Docker version rejection refreshes discovery without replaying a mutation; 404 semantics remain intact', async t => {
  let minimum = '1.40';
  const { docker, calls } = await fixture(t, req => {
    if (req.url === '/version') return { data: { ApiVersion: '1.52', MinAPIVersion: minimum } };
    if (req.method === 'POST') { minimum = '1.44'; return { status: 400, data: { message: 'client version 1.41 is too old. Minimum supported API version is 1.44' } }; }
    return { status: 404, data: { message: 'No such container: fixture' } };
  });
  await assert.rejects(docker('POST', '/containers/create', { Image: 'fixture' }), error => error.dockerStatus === 400 && /Minimum supported API version is 1.44/.test(error.message));
  await assert.rejects(docker('GET', '/containers/fixture/json'), error => error.dockerStatus === 404 && /No such container/.test(error.message));
  assert.deepEqual(calls.map(call => call.url), ['/version', '/v1.41/containers/create', '/version', '/v1.44/containers/fixture/json']);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('runner readiness remains unavailable after Docker configuration fails, and recovers after a successful retry', async t => {
  let broken = true;
  const { root, socketPath, calls } = await fixture(t, req => {
    if (req.url === '/version') return { data: { ApiVersion: '1.52', MinAPIVersion: '1.44' } };
    if (req.url === '/v1.44/containers/fixture-runner/json') return broken
      ? { status: 400, data: { message: 'fixture Docker configuration rejected' } }
      : { data: { Mounts: [{ Destination: path.join(root, 'profiles'), Source: '/fixture/profiles' }] } };
    if (req.url.startsWith('/v1.44/containers/json')) return { data: [] };
    return { status: 500, data: { message: `unexpected request ${req.url}` } };
  });
  const repo = path.resolve(import.meta.dirname, '..');
  let source = await fs.readFile(path.join(repo, 'tg-hosting/runner.mjs'), 'utf8');
  const imports = { ws: import.meta.resolve('ws'), './backup-crypto.cjs': pathToFileURL(path.join(repo, 'server/backup-crypto.cjs')).href };
  for (const file of ['tg-hosting.js', 'tg-docker.js']) imports[`./shared/${file}`] = pathToFileURL(path.join(repo, 'shared', file)).href;
  for (const [from, to] of Object.entries(imports)) source = source.replace(`from '${from}'`, `from ${JSON.stringify(to)}`);
  source = source.replace("const profiles = '/profiles', snapshots = '/snapshots';", `const profiles = ${JSON.stringify(path.join(root, 'profiles'))}, snapshots = ${JSON.stringify(path.join(root, 'snapshots'))};`);
  // Only ownership changes are stubbed for unprivileged macOS/Linux test users.
  source = `import fixtureFs from 'node:fs/promises'; fixtureFs.chown = async () => {};\n${source}`;
  const entry = path.join(root, 'runner.mjs'), runnerSocket = path.join(root, 'r');
  await fs.writeFile(entry, source);
  const child = spawn(process.execPath, [entry], { env: { ...process.env, TG_HOSTING_SOCKET: runnerSocket, DOCKER_SOCKET: socketPath, TG_RUNNER_CONTAINER: 'fixture-runner' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) assert.fail(stderr || 'runner exited before listening');
    try { await fs.stat(runnerSocket); break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const request = (method, endpoint, data) => requestTgJson({ socketPath: runnerSocket, path: endpoint, method, data, timeout: 1000 });
  const data = { key: 'a'.repeat(64), accounts: [], settings: {} };
  const failed = await request('POST', '/configure', data);
  assert.equal(failed.statusCode, 503);
  assert.match(failed.data.error, /fixture Docker configuration rejected/);
  assert.equal((await request('GET', '/status')).statusCode, 503);
  assert.equal((await request('POST', '/backup/start', {})).statusCode, 503);
  broken = false;
  const recovered = await request('POST', '/configure', data);
  assert.equal(recovered.statusCode, 200, JSON.stringify(recovered.data));
  const status = await request('GET', '/status');
  assert.equal(status.statusCode, 200);
  assert.deepEqual(status.data.accounts, []);
  assert.equal(calls.filter(call => call.url === '/version').length, 1);
});
