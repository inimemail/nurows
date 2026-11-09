import fs from 'node:fs/promises';
import path from 'node:path';
import { tgCpuTotal } from './tg-hosting.js';

// Each browser keeps its own quota. The parent quota lets idle browsers lend
// their unused CPU to busy browsers, without reserving or dividing that quota.
// A tiny sleep container keeps Docker/systemd's parent alive across admissions.
export function createTgCpuGroup({ docker, io = fs, root = '/host-cgroup', now = Date.now }) {
  let config, state = { ready: false, error: '' }, checkedAt = 0, retryAt = 0;
  const parent = info => info.cgroupDriver === 'systemd' ? `nurosshtg${config.namespace}.slice` : `/nurossh-tg-${config.namespace}`;
  const includes = value => Boolean(config && [parent({ cgroupDriver: 'systemd' }), parent({ cgroupDriver: 'cgroupfs' })].includes(value));
  const anchor = () => `nurossh-tg-${config.namespace}-cpu`;
  function configure(value) {
    if (!/^[a-f0-9]{12}$/.test(value.namespace) || !value.hostProfiles?.startsWith('/')) throw Error('共享 CPU 归属无效');
    config = value; checkedAt = 0; retryAt = 0;
  }
  async function inspect() {
    try { return await docker('GET', `/containers/${anchor()}/json`, undefined, 2000); }
    catch (error) { if (error.dockerStatus === 404) return null; throw error; }
  }
  function owned(container, expectedParent) {
    if (container.Config?.Labels?.['nurossh.tg.owner'] !== config.namespace ||
        container.Config?.Labels?.['nurossh.tg.cpu-group'] !== '1' ||
        container.HostConfig?.CgroupParent !== expectedParent ||
        !container.Mounts?.some(m => m.Source === config.hostProfiles && m.Destination === '/ownership' && m.RW === false)) throw Error('共享 CPU 组件归属校验失败');
  }
  async function files(info, expectedParent) {
    let directory = root;
    if (info.cgroupVersion === '1') {
      const names = await io.readdir(root);
      const cpu = names.find(n => n === 'cpu' || n === 'cpu,cpuacct' || n === 'cpuacct,cpu');
      if (!cpu) throw Error('宿主机未挂载 CPU cgroup 控制器');
      directory = path.join(root, cpu);
    }
    directory = await io.realpath(directory);
    const group = path.join(directory, expectedParent.replace(/^\//, ''));
    // Do not follow a substituted group/file into an unrelated host cgroup.
    if (await io.realpath(group) !== group) throw Error('共享 CPU 分组路径无效');
    const names = info.cgroupVersion === '2' ? ['cpu.max'] : ['cpu.cfs_quota_us', 'cpu.cfs_period_us'];
    const result = names.map(n => path.join(group, n));
    for (const file of result) if (await io.realpath(file) !== file) throw Error('共享 CPU 控制路径无效');
    return result;
  }
  async function ensure(info, settings, force = false) {
    let total;
    try { total = tgCpuTotal(info.totalCpus, settings.cpuTotal); }
    catch (error) { state = { ready: false, error: error.message }; return state; }
    const wanted = `${info.cgroupDriver}/${info.cgroupVersion}/${total}`;
    if (!force && wanted === state.signature && state.ready && now() - checkedAt < 60000) return state;
    if (wanted === state.signature && now() < retryAt) return state;
    try {
      if (!config?.mounted) throw Error('组件缺少共享 CPU 挂载，请用管理脚本菜单 2 升级组件');
      if (!['cgroupfs', 'systemd'].includes(info.cgroupDriver) || !['1', '2'].includes(info.cgroupVersion)) throw Error('当前 Docker cgroup 模式不支持共享 CPU 限额');
      const expectedParent = parent(info);
      let container = await inspect();
      if (!container) {
        await docker('POST', `/containers/create?name=${anchor()}`, {
          Image: config.image, User: '65534:65534', Entrypoint: ['/bin/sleep'], Cmd: ['infinity'],
          Healthcheck: { Test: ['NONE'] },
          Labels: { 'nurossh.tg.owner': config.namespace, 'nurossh.tg.cpu-group': '1' },
          HostConfig: { CgroupParent: expectedParent, Binds: [`${config.hostProfiles}:/ownership:ro`], NetworkMode: 'none', ReadonlyRootfs: true,
            CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Memory: 16 * 1024 ** 2, MemorySwap: 16 * 1024 ** 2,
            NanoCpus: 10000000, PidsLimit: 8, LogConfig: { Type: 'none' }, RestartPolicy: { Name: 'no' } },
        }, 3000);
        container = await inspect();
      }
      owned(container, expectedParent);
      if (!container.State.Running) await docker('POST', `/containers/${container.Id}/start`, undefined, 3000);
      const control = await files(info, expectedParent);
      // Keep the period fixed so one cpu.max write is atomic on cgroup v2.
      const period = info.cgroupVersion === '2' ? 100000 : Number((await io.readFile(control[1], 'utf8')).trim());
      if (!Number.isInteger(period) || period < 1000 || period > 1000000) throw Error('共享 CPU 调度周期无效');
      const quota = Math.max(1000, Math.floor(total * period));
      await io.writeFile(control[0], info.cgroupVersion === '2' ? `${quota} ${period}` : String(quota));
      const actual = (await io.readFile(control[0], 'utf8')).trim().split(/\s+/).map(Number);
      if (actual[0] !== quota || info.cgroupVersion === '2' && actual[1] !== period) throw Error('共享 CPU 限额写入未确认');
      state = { ready: true, total: quota / period, parent: expectedParent, signature: wanted, error: '' };
      checkedAt = now(); retryAt = 0;
    } catch (error) {
      state = { ready: false, total, signature: wanted, error: `共享 CPU 限额未生效：${error.message}` };
      retryAt = now() + 30000;
    }
    return state;
  }
  async function release() {
    if (!config) return;
    const container = await inspect();
    if (container) {
      if (!includes(container.HostConfig?.CgroupParent)) throw Error('共享 CPU 分组归属无效');
      owned(container, container.HostConfig.CgroupParent);
      await docker('DELETE', `/containers/${container.Id}?force=true`, undefined, 3000);
    }
    state = { ready: false, error: '' }; checkedAt = 0; retryAt = 0;
  }
  return { configure, ensure, release, includes, status: () => ({ ready: state.ready, total: state.total, error: state.error }), parent: () => state.ready ? state.parent : undefined };
}
