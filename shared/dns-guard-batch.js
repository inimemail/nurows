export const DNS_GUARD_BATCH_ACTIONS = [
  ['ips_add', '批量添加 IP'], ['ips_remove', '批量移除 IP'],
  ['sources_enabled', '启用 / 禁用域名来源'],
  ['sources_add', '增加 DDNS 来源'], ['sources_remove', '删除指定 DDNS 来源'],
  ['sources_replace', '替换 DDNS 来源'], ['sources_map', '按域名修改 DDNS 来源'],
  ['enabled', '启用 / 停用守护任务'], ['check', '立即检查'],
  ['references', '调整探针 / 备用池 / 通知'], ['settings', '调整检查与补位参数']
];

export const DNS_GUARD_BATCH_SETTINGS = [
  ['interval', '检查间隔（秒）', 10, 86400], ['timeout', '每轮超时（秒）', 1, 60],
  ['checkRounds', '检查轮数', 1, 10], ['attemptsPerRound', '每轮次数', 1, 10],
  ['maxParallel', '单探针并发', 1, 300], ['ttl', 'DNS TTL（秒）', 1, 86400],
  ['maxActiveIps', '活动 IP 上限', 1, 50], ['poolTargetCount', '补满目标数量', 1, 50],
  ['poolRebalanceIntervalMinutes', '均衡间隔（分钟）', 1, 1440]
];

export const dnsGuardBatchLabel = action => DNS_GUARD_BATCH_ACTIONS.find(([id]) => id === action)?.[1] || action;
