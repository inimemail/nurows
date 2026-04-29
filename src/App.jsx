import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';

const EMPTY_SERVER = {
  id: '',
  name: '',
  host: '',
  port: 22,
  username: 'root',
  password: '',
  groupId: 'group-default',
  proxyId: '',
  note: ''
};

const EMPTY_COMMAND = {
  id: '',
  name: '',
  command: ''
};

const EMPTY_PROXY = {
  id: '',
  name: '',
  type: 'http',
  host: '',
  port: 1080,
  username: '',
  password: ''
};

const EMPTY_GROUP = {
  id: '',
  name: '',
  note: ''
};

const EMPTY_BATCH_INPUT_DIALOG = {
  open: false,
  mode: 'choice',
  value: '',
  awaitingServerIds: [],
  signature: ''
};

const INTERACTIVE_KEYWORDS_STORAGE_KEY = 'nurossh-interactive-keywords';
const DEFAULT_INTERACTIVE_KEYWORDS = ['请', '请输入', '请选择', '按回车'];

const TABS = [
  { key: 'servers', label: '服务器', icon: ServerIcon },
  { key: 'commands', label: '命令中心', icon: CommandIcon },
  { key: 'proxies', label: '代理网络', icon: ProxyIcon }
];

const TERMINAL_SESSIONS_STORAGE_KEY = 'nurossh-terminal-sessions';
const ACTIVE_TERMINAL_STORAGE_KEY = 'nurossh-active-terminal-id';
const BATCH_INPUT_SERVER_BUTTON_LIMIT = 12;
const LOCAL_SHELL_PROMPT_PATTERNS = [
  /^[^@\s]+@[^:\s]+(?::.*)?[#$]\s*$/,
  /^\[[^@\]]+@[^ \]]+[^\]]*\][#$]\s*$/,
  /^[A-Za-z]:\\.*>\s*$/
];

function sanitizeInteractiveKeywords(items, { fallbackToDefault = true } = {}) {
  const cleaned = Array.isArray(items)
    ? items
        .map((item) => String(item || '').trim())
        .filter(Boolean)
    : [];
  return cleaned.length || !fallbackToDefault ? cleaned : DEFAULT_INTERACTIVE_KEYWORDS;
}

function parseInteractiveKeywordsText(value, options) {
  return sanitizeInteractiveKeywords(String(value || '').split(/\r?\n/), options);
}

function readInteractiveKeywords() {
  try {
    const raw = localStorage.getItem(INTERACTIVE_KEYWORDS_STORAGE_KEY);
    const parsed = JSON.parse(raw || '[]');
    return sanitizeInteractiveKeywords(parsed);
  } catch (_error) {
    return DEFAULT_INTERACTIVE_KEYWORDS;
  }
}

function formatTerminalSessionTitle(serverName, instanceNo = 0) {
  return instanceNo > 0 ? `${serverName}(${instanceNo})` : serverName;
}

function cleanTerminalOutput(value) {
  const normalized = String(value || '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/(?:^|\r?\n).*__NUROSSH_EXIT__.*(?:\r?\n|$)/g, '\n')
    .replace(/(?:^|\r?\n).*printf '\\n__NUROSSH_EXIT__:%s\\n' \"\\\$\\?\".*(?:\r?\n|$)/g, '\n')
    .replace(/(?:^|\r?\n).*(?:__NUROSSH_STATUS=\$\?|__NUROSSH_FINAL_STATUS=|unset __NUROSSH_STATUS|unset -f __nurossh_run|exit "\$__NUROSSH_FINAL_STATUS"|exit "\$__NUROSSH_STATUS").*(?:\r?\n|$)/g, '\n')
    .replace(/\r/g, '');

  const lines = normalized.split('\n');
  const cleanedLines = [];
  let skippingWrapperDefinition = false;

  for (const rawLine of lines) {
    const line = String(rawLine || '');
    const trimmed = line.trim();

    if (
      /(?:^|\s)__nurossh_run\(\)\s*\{$/.test(trimmed) ||
      /(?:^|\s)__nurossh_run\s*$/.test(trimmed)
    ) {
      skippingWrapperDefinition = trimmed.endsWith('{');
      continue;
    }

    if (skippingWrapperDefinition) {
      if (/^>\s*}\s*$/.test(trimmed) || trimmed === '}') {
        skippingWrapperDefinition = false;
      }
      continue;
    }

    if (
      /^>\s*$/.test(trimmed) ||
      /^>\s*}\s*$/.test(trimmed) ||
      /^root@localhost:.*#\s*$/.test(trimmed) ||
      /^logout\s*$/.test(trimmed)
    ) {
      continue;
    }

    cleanedLines.push(line);
  }

  return cleanedLines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

function getLastNonEmptyOutputLine(value) {
  const lines = String(value || '')
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] || '';
}

function looksLikeLocalShellPrompt(value) {
  const line = String(value || '').trim();
  return LOCAL_SHELL_PROMPT_PATTERNS.some((pattern) => pattern.test(line));
}

function reconcileExecutionResults(items) {
  return (Array.isArray(items) ? items : []).map((item) => {
    if (!item || item.status === 'done' || item.status === 'error') {
      return item;
    }
    const output = cleanTerminalOutput([item.stdout, item.stderr, item.error].filter(Boolean).join('\n'));
    const lastLine = getLastNonEmptyOutputLine(output);
    const hasWrapperCleanupTrace = /__NUROSSH_STATUS=\$\?|__NUROSSH_FINAL_STATUS=|unset -f __nurossh_run|logout/.test(output);
    if ((item.inputRequestCount > 0 || hasWrapperCleanupTrace) && looksLikeLocalShellPrompt(lastLine)) {
      return {
        ...item,
        ok: !item.error,
        status: 'done',
        exitCode: Number.isFinite(item.exitCode) ? item.exitCode : 0,
        awaitingInput: false
      };
    }
    return item;
  });
}

function formatExecutionResultOutput(resultItem, serverItem, commandText = '') {
  if (!resultItem && !serverItem) {
    return '[系统] 暂无可显示的执行结果。';
  }

  const name = resultItem?.name || serverItem?.name || '执行结果';
  const host = resultItem?.host || serverItem?.host || '';
  const username = serverItem?.username || 'root';
  const promptHost = host || 'localhost';
  const prompt = `${username}@${promptHost}:~#`;
  const commandLine = String(commandText || '').trim();

  if (resultItem?.status === 'queued' || resultItem?.status === 'running') {
    return [
      `[系统] 已连接 ${name}${host ? ` (${host})` : ''}`,
      `${prompt}${commandLine ? ` ${commandLine}` : ''}`,
      '[系统] 命令仍在执行中，请等待返回日志。'
    ].join('\r\n');
  }

  const outputText = resultItem?.error
    ? resultItem.error
    : cleanTerminalOutput([resultItem?.stdout, resultItem?.stderr].filter(Boolean).join('\n'));

  const transcript = [
    `[系统] 已连接 ${name}${host ? ` (${host})` : ''}`,
    `${prompt}${commandLine ? ` ${commandLine}` : ''}`
  ];

  if (resultItem?.error) {
    transcript.push(outputText || '[错误] 执行失败');
    transcript.push(prompt);
    return transcript.join('\r\n');
  }

  transcript.push(outputText || '[系统] 命令已执行完成，但没有返回任何日志。');
  transcript.push(prompt);
  return transcript.join('\r\n');
}

function normalizeTerminalSessions(items) {
  const instanceCounters = new Map();
  return items
    .filter((item) => item && typeof item.id === 'string' && typeof item.serverId === 'string')
    .map((item) => {
      const nextFallbackIndex = instanceCounters.get(item.serverId) || 0;
      const instanceNo =
        Number.isInteger(item.instanceNo) && item.instanceNo >= 0
          ? item.instanceNo
          : nextFallbackIndex;
      instanceCounters.set(item.serverId, Math.max(nextFallbackIndex, instanceNo + 1));
      return {
        id: item.id,
        serverId: item.serverId,
        instanceNo,
        title: typeof item.title === 'string' ? item.title : item.serverId
      };
    });
}

function readStoredTerminalSessions() {
  try {
    const raw = localStorage.getItem(TERMINAL_SESSIONS_STORAGE_KEY);
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) {
      return [];
    }
    return normalizeTerminalSessions(parsed);
  } catch (_error) {
    return [];
  }
}

function readStoredActiveTerminalId() {
  try {
    return localStorage.getItem(ACTIVE_TERMINAL_STORAGE_KEY) || '';
  } catch (_error) {
    return '';
  }
}

function normalizeWorkspacePayload(workspace = {}) {
  return {
    tab: workspace.tab === 'commands' || workspace.tab === 'proxies' ? workspace.tab : 'servers',
    search: typeof workspace.search === 'string' ? workspace.search : '',
    selectedServerId: typeof workspace.selectedServerId === 'string' ? workspace.selectedServerId : '',
    selectedCommandId: typeof workspace.selectedCommandId === 'string' ? workspace.selectedCommandId : '',
    selectedProxyId: typeof workspace.selectedProxyId === 'string' ? workspace.selectedProxyId : '',
    selectedServerIds: Array.isArray(workspace.selectedServerIds)
      ? workspace.selectedServerIds.filter((item) => typeof item === 'string')
      : [],
    commandText: typeof workspace.commandText === 'string' ? workspace.commandText : '',
    collapsedGroups: workspace.collapsedGroups && typeof workspace.collapsedGroups === 'object'
      ? Object.fromEntries(
          Object.entries(workspace.collapsedGroups).filter(([, value]) => typeof value === 'boolean')
        )
      : {},
    executionResults: Array.isArray(workspace.executionResults)
      ? workspace.executionResults
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
    lastExecutedCommand: typeof workspace.lastExecutedCommand === 'string' ? workspace.lastExecutedCommand : '',
    commandJobId: typeof workspace.commandJobId === 'string' ? workspace.commandJobId : '',
    commandInteractiveKeywords: sanitizeInteractiveKeywords(workspace.commandInteractiveKeywords, { fallbackToDefault: false }),
    commandJobStatus:
      workspace.commandJobStatus === 'running' || workspace.commandJobStatus === 'done'
        ? workspace.commandJobStatus
        : 'idle',
    sessions: Array.isArray(workspace.sessions) ? normalizeTerminalSessions(workspace.sessions) : [],
    activeTerminalId: typeof workspace.activeTerminalId === 'string' ? workspace.activeTerminalId : ''
  };
}

export default function App() {
  const restoringWorkspaceRef = useRef(false);
  const [theme, setTheme] = useState(() => localStorage.getItem('nurossh-theme') || 'nuro-dark');
  const [auth, setAuth] = useState({ loading: true, configured: false, authenticated: false, username: '' });
  const [authForm, setAuthForm] = useState({ username: '', password: '', confirmPassword: '' });
  const [authError, setAuthError] = useState('');
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState({ open: false, title: '', message: '', onConfirm: null });
  const [accountForm, setAccountForm] = useState({
    username: '',
    currentPassword: '',
    newPassword: '',
    confirmPassword: ''
  });
  const [accountError, setAccountError] = useState('');

  const [state, setState] = useState({ groups: [], servers: [], commands: [], proxies: [] });
  const [tab, setTab] = useState('servers');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState({});
  const [selectedServerId, setSelectedServerId] = useState('');
  const [selectedCommandId, setSelectedCommandId] = useState('');
  const [selectedProxyId, setSelectedProxyId] = useState('');
  const [selectedServerIds, setSelectedServerIds] = useState([]);
  const [commandText, setCommandText] = useState('');
  const [executionResults, setExecutionResults] = useState([]);
  const [lastExecutedCommand, setLastExecutedCommand] = useState('');
  const [commandJobId, setCommandJobId] = useState('');
  const [commandInteractiveKeywords, setCommandInteractiveKeywords] = useState(() => readInteractiveKeywords());
  const [commandJobStatus, setCommandJobStatus] = useState('idle');
  const [serverDraft, setServerDraft] = useState(EMPTY_SERVER);
  const [showServerPassword, setShowServerPassword] = useState(false);
  const [commandDraft, setCommandDraft] = useState(EMPTY_COMMAND);
  const [proxyDraft, setProxyDraft] = useState(EMPTY_PROXY);
  const [editorDialog, setEditorDialog] = useState({ open: false, type: 'server', mode: 'edit' });
  const [groupDialog, setGroupDialog] = useState({ open: false, value: EMPTY_GROUP });
  const [importDialog, setImportDialog] = useState({
    open: false,
    text: '',
    preview: null,
    confirmOverwrite: false,
    loading: false
  });
  const [serverPickerOpen, setServerPickerOpen] = useState(false);
  const [serverPickerMode, setServerPickerMode] = useState('command');
  const [pickerSearch, setPickerSearch] = useState('');
  const [pickerGroupId, setPickerGroupId] = useState('all');
  const [pickerSelectedIds, setPickerSelectedIds] = useState([]);
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const [terminalSessions, setTerminalSessions] = useState([]);
  const [activeTerminalId, setActiveTerminalId] = useState('');
  const [terminalFullscreenOpen, setTerminalFullscreenOpen] = useState(false);
  const [resultTerminalServerId, setResultTerminalServerId] = useState('');
  const [batchInputDialog, setBatchInputDialog] = useState(EMPTY_BATCH_INPUT_DIALOG);
  const [handledBatchInputSignature, setHandledBatchInputSignature] = useState('');
  const [interactiveKeywordsDialogOpen, setInteractiveKeywordsDialogOpen] = useState(false);
  const [interactiveKeywordsText, setInteractiveKeywordsText] = useState(() => readInteractiveKeywords().join('\n'));
  const [interactiveKeywords, setInteractiveKeywords] = useState(() => readInteractiveKeywords());
  const [runCommandConfirmOpen, setRunCommandConfirmOpen] = useState(false);
  const [temporaryKeywordsDialogOpen, setTemporaryKeywordsDialogOpen] = useState(false);
  const [temporaryInteractiveKeywordsText, setTemporaryInteractiveKeywordsText] = useState('');
  const [assetDrawerOpen, setAssetDrawerOpen] = useState(true);
  const [toasts, setToasts] = useState([]);
  const [stateLoaded, setStateLoaded] = useState(false);

  useEffect(() => {
    bootstrap();
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('nurossh-theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(INTERACTIVE_KEYWORDS_STORAGE_KEY, JSON.stringify(interactiveKeywords));
  }, [interactiveKeywords]);

  useEffect(() => {
    if (commandJobId) {
      return;
    }
    setCommandInteractiveKeywords(interactiveKeywords);
  }, [commandJobId, interactiveKeywords]);

  useEffect(() => {
    if (!auth.authenticated) {
      return;
    }
    setStateLoaded(false);
    setTerminalSessions([]);
    setActiveTerminalId('');
    loadState();
  }, [auth.authenticated]);

  useEffect(() => {
    setAccountForm((current) => ({
      ...current,
      username: auth.username || 'admin'
    }));
  }, [auth.username]);

  useEffect(() => {
    if (!state.groups.length) {
      return;
    }
    setCollapsedGroups((current) => {
      const next = { ...current };
      for (const group of state.groups) {
        if (!(group.id in next)) {
          next[group.id] = false;
        }
      }
      return next;
    });
  }, [state.groups]);

  useEffect(() => {
    if (editorDialog.open && editorDialog.type === 'server' && editorDialog.mode === 'create') {
      return;
    }
    const selected = state.servers.find((item) => item.id === selectedServerId);
    setServerDraft(selected ? { ...selected } : { ...EMPTY_SERVER, groupId: state.groups[0]?.id || 'group-default' });
  }, [selectedServerId, state.servers, state.groups, editorDialog]);

  useEffect(() => {
    if (editorDialog.open && editorDialog.type === 'command' && editorDialog.mode === 'create') {
      return;
    }
    const selected = state.commands.find((item) => item.id === selectedCommandId);
    setCommandDraft(selected ? { ...selected } : { ...EMPTY_COMMAND });
    if (selected?.command && !restoringWorkspaceRef.current) {
      setCommandText(selected.command);
    }
  }, [selectedCommandId, state.commands, editorDialog]);

  useEffect(() => {
    if (editorDialog.open && editorDialog.type === 'proxy' && editorDialog.mode === 'create') {
      return;
    }
    const selected = state.proxies.find((item) => item.id === selectedProxyId);
    setProxyDraft(selected ? { ...selected } : { ...EMPTY_PROXY });
  }, [selectedProxyId, state.proxies, editorDialog]);

  useEffect(() => {
    if (!stateLoaded) {
      return;
    }
    if (selectedServerId && !state.servers.some((item) => item.id === selectedServerId)) {
      setSelectedServerId('');
    }
    if (selectedCommandId && !state.commands.some((item) => item.id === selectedCommandId)) {
      setSelectedCommandId('');
    }
    if (selectedProxyId && !state.proxies.some((item) => item.id === selectedProxyId)) {
      setSelectedProxyId('');
    }
    setSelectedServerIds((current) => current.filter((id) => state.servers.some((item) => item.id === id)));
    setTerminalSessions((current) => current.filter((session) => state.servers.some((item) => item.id === session.serverId)));
  }, [state, selectedServerId, selectedCommandId, selectedProxyId, stateLoaded]);

  useEffect(() => {
    if (!terminalSessions.some((item) => item.id === activeTerminalId)) {
      setActiveTerminalId(terminalSessions[0]?.id || '');
    }
  }, [terminalSessions, activeTerminalId]);

  useEffect(() => {
    const instanceCounters = new Map();
    const nextSessions = terminalSessions
      .map((session) => {
        const serverItem = state.servers.find((item) => item.id === session.serverId);
        if (!serverItem) {
          return null;
        }
        const nextFallbackIndex = instanceCounters.get(session.serverId) || 0;
        const instanceNo =
          Number.isInteger(session.instanceNo) && session.instanceNo >= 0
            ? session.instanceNo
            : nextFallbackIndex;
        instanceCounters.set(session.serverId, Math.max(nextFallbackIndex, instanceNo + 1));
        return {
          ...session,
          instanceNo,
          title: formatTerminalSessionTitle(serverItem.name, instanceNo)
        };
      })
      .filter(Boolean);

    const changed =
      nextSessions.length !== terminalSessions.length ||
      nextSessions.some((session, index) =>
        session.id !== terminalSessions[index]?.id ||
        session.serverId !== terminalSessions[index]?.serverId ||
        session.instanceNo !== terminalSessions[index]?.instanceNo ||
        session.title !== terminalSessions[index]?.title
      );

    if (changed) {
      setTerminalSessions(nextSessions);
    }
  }, [state.servers, terminalSessions]);

  useEffect(() => {
    localStorage.setItem(TERMINAL_SESSIONS_STORAGE_KEY, JSON.stringify(terminalSessions));
  }, [terminalSessions]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_TERMINAL_STORAGE_KEY, activeTerminalId);
  }, [activeTerminalId]);

  useEffect(() => {
    if (!auth.authenticated || !stateLoaded) {
      return;
    }
    const timer = window.setTimeout(() => {
      api('/api/workspace', {
        method: 'POST',
        body: JSON.stringify({
          tab,
          search,
          selectedServerId,
          selectedCommandId,
          selectedProxyId,
          selectedServerIds,
          commandText,
          collapsedGroups,
          executionResults,
          lastExecutedCommand,
          commandJobId,
          commandInteractiveKeywords,
          commandJobStatus,
          sessions: terminalSessions,
          activeTerminalId
        }),
        onUnauthorized: () => setAuth((current) => ({ ...current, authenticated: false }))
      }).catch(() => undefined);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    auth.authenticated,
    stateLoaded,
    tab,
    search,
    selectedServerId,
    selectedCommandId,
    selectedProxyId,
    selectedServerIds,
    commandText,
    collapsedGroups,
    executionResults,
    lastExecutedCommand,
    commandJobId,
    commandInteractiveKeywords,
    commandJobStatus,
    terminalSessions,
    activeTerminalId
  ]);

  useEffect(() => {
    if (!toasts.length) {
      return;
    }
    const timer = window.setTimeout(() => {
      setToasts((current) => current.slice(1));
    }, 2400);
    return () => window.clearTimeout(timer);
  }, [toasts]);

  useEffect(() => {
    if (!commandJobId || commandJobStatus === 'done') {
      return;
    }

    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const data = await api(`/api/commands/jobs/${commandJobId}`, {
          onUnauthorized: () => setAuth((current) => ({ ...current, authenticated: false }))
        });
        if (cancelled) {
          return;
        }
        const nextResults = reconcileExecutionResults(data.results || []);
        setExecutionResults(nextResults);
        setLastExecutedCommand(data.command || '');
        setCommandInteractiveKeywords(sanitizeInteractiveKeywords(data.interactiveKeywords, { fallbackToDefault: false }));
        const nextStatus = nextResults.every((item) => ['done', 'error'].includes(item.status)) ? 'done' : (data.status || 'done');
        setCommandJobStatus(nextStatus);
        if (nextStatus === 'done') {
          setBusy((current) => ({ ...current, runCommand: false }));
          window.clearInterval(timer);
        }
      } catch (_error) {
        if (!cancelled) {
          const nextResults = reconcileExecutionResults(executionResults);
          if (nextResults.every((item) => ['done', 'error'].includes(item.status))) {
            setExecutionResults(nextResults);
            setCommandJobStatus('done');
            setCommandJobId('');
          }
          setBusy((current) => ({ ...current, runCommand: false }));
          window.clearInterval(timer);
        }
      }
    }, 700);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [commandJobId, commandJobStatus]);

  const filteredServers = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return state.servers.filter((item) => {
      if (!keyword) {
        return true;
      }
      return [item.name, item.host, item.username, item.note].some((text) =>
        String(text || '').toLowerCase().includes(keyword)
      );
    });
  }, [search, state.servers]);

  const pickerFilteredServers = useMemo(() => {
    const keyword = pickerSearch.trim().toLowerCase();
    return state.servers.filter((item) => {
      const matchGroup = pickerGroupId === 'all' ? true : item.groupId === pickerGroupId;
      if (!matchGroup) {
        return false;
      }
      if (!keyword) {
        return true;
      }
      return [item.name, item.host, item.username, item.note].some((text) =>
        String(text || '').toLowerCase().includes(keyword)
      );
    });
  }, [pickerGroupId, pickerSearch, state.servers]);

  const filteredCommands = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return state.commands.filter((item) => {
      if (!keyword) {
        return true;
      }
      return [item.name, item.command].some((text) => text.toLowerCase().includes(keyword));
    });
  }, [search, state.commands]);

  const filteredProxies = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return state.proxies.filter((item) => {
      if (!keyword) {
        return true;
      }
      return [item.name, item.host, item.type].some((text) => text.toLowerCase().includes(keyword));
    });
  }, [search, state.proxies]);

  const activeTerminal = terminalSessions.find((item) => item.id === activeTerminalId) || null;
  const selectedServer = state.servers.find((item) => item.id === selectedServerId) || null;
  const selectedCommand = state.commands.find((item) => item.id === selectedCommandId) || null;
  const selectedProxy = state.proxies.find((item) => item.id === selectedProxyId) || null;
  const resultTerminalResult = executionResults.find((item) => item.serverId === resultTerminalServerId) || null;
  const resultTerminalServer = state.servers.find((item) => item.id === resultTerminalServerId) || null;
  const resultTerminalIsLive = Boolean(
    commandJobId &&
    resultTerminalResult &&
    ['queued', 'running', 'awaiting_input'].includes(resultTerminalResult.status)
  );
  const resultTerminalSession = resultTerminalServerId
    ? {
        id: `result-${resultTerminalServerId}`,
        serverId: resultTerminalServerId,
        title: resultTerminalResult?.name || resultTerminalServer?.name || resultTerminalServerId,
        jobId: resultTerminalIsLive ? commandJobId : '',
        mode: resultTerminalIsLive ? 'command-job' : 'result',
        content: formatExecutionResultOutput(resultTerminalResult, resultTerminalServer, lastExecutedCommand)
      }
    : null;
  const proxyUsage = state.servers.filter((item) => item.proxyId === selectedProxyId);
  const boundProxyCount = state.servers.filter((item) => item.proxyId).length;
  const awaitingInputResults = executionResults.filter((item) => item.status === 'awaiting_input' || item.awaitingInput);
  const awaitingInputPreview = cleanTerminalOutput(
    awaitingInputResults
      .map((item) => {
        const body = cleanTerminalOutput([item.stdout, item.stderr].filter(Boolean).join('\n'));
        return `# ${item.name} (${item.host})\n${body || '[暂无日志]'}`;
      })
      .join('\n\n')
  );
  const awaitingInputSignature = awaitingInputResults
    .map((item) => `${item.serverId}:${item.inputRequestCount || 0}`)
    .sort()
    .join('|');
  const batchInputAwaitingResults = batchInputDialog.awaitingServerIds
    .map((serverId) => executionResults.find((item) => item.serverId === serverId))
    .filter(Boolean);
  const visibleBatchInputAwaitingResults = batchInputAwaitingResults.slice(0, BATCH_INPUT_SERVER_BUTTON_LIMIT);
  const hiddenBatchInputAwaitingResultsCount = Math.max(0, batchInputAwaitingResults.length - visibleBatchInputAwaitingResults.length);
  const resolvedCommandResultCount = executionResults.filter((item) => ['done', 'error', 'awaiting_input'].includes(item.status)).length;
  const pendingCommandResultCount = Math.max(0, executionResults.length - resolvedCommandResultCount);
  const allCommandResultsPausedOrFinished =
    executionResults.length > 0 &&
    executionResults.every((item) => ['done', 'error', 'awaiting_input'].includes(item.status));
  const batchInputReady = allCommandResultsPausedOrFinished && awaitingInputResults.length > 0;
  const commandProgress = {
    total: executionResults.length,
    running: executionResults.filter((item) => item.status === 'queued' || item.status === 'running' || item.status === 'awaiting_input').length
  };
  const isCommandRunning = commandJobStatus === 'running';
  const hasCommandResults = executionResults.length > 0;
  const canClearCommandResults = hasCommandResults || isCommandRunning;
  const canRunCommand = !isCommandRunning && selectedServerIds.length > 0 && String(commandText || '').trim().length > 0;
  const workspaceFullscreenActive = Boolean(terminalFullscreenOpen && tab === 'servers' && activeTerminal);
  const searchPlaceholder =
    tab === 'servers'
      ? '搜索服务器名称、IP'
      : tab === 'commands'
        ? '搜索命令名称'
        : '搜索代理名称、地址';

  useEffect(() => {
    if (!activeTerminal) {
      setTerminalFullscreenOpen(false);
    }
  }, [activeTerminal]);

  useEffect(() => {
    if (resultTerminalServerId && !executionResults.some((item) => item.serverId === resultTerminalServerId)) {
      setResultTerminalServerId('');
    }
  }, [executionResults, resultTerminalServerId]);

  useEffect(() => {
    if (!commandJobId || !awaitingInputSignature || !allCommandResultsPausedOrFinished) {
      return;
    }
    if (awaitingInputSignature === handledBatchInputSignature) {
      return;
    }
    setHandledBatchInputSignature(awaitingInputSignature);
    setBatchInputDialog({
      open: true,
      mode: 'choice',
      value: '',
      awaitingServerIds: awaitingInputResults.map((item) => item.serverId),
      signature: awaitingInputSignature
    });
  }, [
    allCommandResultsPausedOrFinished,
    awaitingInputResults,
    awaitingInputSignature,
    commandJobId,
    handledBatchInputSignature
  ]);

  async function bootstrap() {
    try {
      const status = await api('/api/auth/status', { authFree: true });
      setAuth({ loading: false, ...status });
    } catch (error) {
      setAuth({ loading: false, configured: false, authenticated: false, username: '' });
      setAuthError(error.message);
    }
  }

  async function loadState() {
    try {
      const data = await api('/api/state', {
        onUnauthorized: () => setAuth((current) => ({ ...current, authenticated: false }))
      });
      setState(data);
      const serverWorkspace = normalizeWorkspacePayload(data.workspace);
      const knownServerIds = new Set((data.servers || []).map((item) => item.id));
      const filteredWorkspaceSessions = serverWorkspace.sessions.filter((item) => knownServerIds.has(item.serverId));
      const filteredStoredSessions = readStoredTerminalSessions().filter((item) => knownServerIds.has(item.serverId));
      const preferredSessions = filteredWorkspaceSessions.length ? filteredWorkspaceSessions : filteredStoredSessions;
      const preferredActiveId =
        filteredWorkspaceSessions.some((item) => item.id === serverWorkspace.activeTerminalId)
          ? serverWorkspace.activeTerminalId
          : (preferredSessions[0]?.id || '');
      const hasServerWorkspace =
        filteredWorkspaceSessions.length > 0 ||
        Boolean(serverWorkspace.activeTerminalId) ||
        serverWorkspace.tab !== 'servers' ||
        Boolean(serverWorkspace.search) ||
        Boolean(serverWorkspace.selectedServerId) ||
        Boolean(serverWorkspace.selectedCommandId) ||
        Boolean(serverWorkspace.selectedProxyId) ||
        serverWorkspace.selectedServerIds.length > 0 ||
        Boolean(serverWorkspace.commandText);
      if (hasServerWorkspace || !terminalSessions.length) {
        restoringWorkspaceRef.current = true;
        setTab(serverWorkspace.tab);
        setSearch(serverWorkspace.search);
        setSelectedServerId(serverWorkspace.selectedServerId);
        setSelectedCommandId(serverWorkspace.selectedCommandId);
        setSelectedProxyId(serverWorkspace.selectedProxyId);
        setSelectedServerIds(serverWorkspace.selectedServerIds);
        setCommandText(serverWorkspace.commandText);
        setCollapsedGroups((current) => ({ ...current, ...serverWorkspace.collapsedGroups }));
        setExecutionResults(reconcileExecutionResults(serverWorkspace.executionResults));
        setLastExecutedCommand(serverWorkspace.lastExecutedCommand);
        setCommandJobId(serverWorkspace.commandJobId);
        setCommandInteractiveKeywords(
          serverWorkspace.commandJobId
            ? serverWorkspace.commandInteractiveKeywords
            : readInteractiveKeywords()
        );
        setCommandJobStatus(serverWorkspace.commandJobStatus);
        setTerminalSessions(preferredSessions);
        setActiveTerminalId(preferredActiveId);
        window.setTimeout(() => {
          restoringWorkspaceRef.current = false;
        }, 0);
      }
      setStateLoaded(true);
    } catch (error) {
      setStateLoaded(true);
      toast(error.message);
    }
  }

  function toast(message) {
    setToasts((current) => [...current, { id: crypto.randomUUID(), message }]);
  }

  function openConfirm({ title = '确认操作', message = '确定继续吗？', onConfirm }) {
    setConfirmDialog({ open: true, title, message, onConfirm });
  }

  function closeConfirm() {
    setConfirmDialog({ open: false, title: '', message: '', onConfirm: null });
  }

  function setActionBusy(key, value) {
    setBusy((current) => ({ ...current, [key]: value }));
  }

  async function submitAuth(mode) {
    setAuthError('');
    if (!authForm.username.trim()) {
      setAuthError('请输入用户名');
      return;
    }
    if (mode === 'setup' && authForm.password !== authForm.confirmPassword) {
      setAuthError('两次密码输入不一致');
      return;
    }

    try {
      setActionBusy(mode === 'setup' ? 'setup' : 'login', true);
      const payload = {
        username: authForm.username.trim(),
        password: authForm.password
      };
      const data = await api(mode === 'setup' ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(payload),
        authFree: true
      });
      setAuth({ loading: false, ...data });
      setAuthForm((current) => ({ ...current, password: '', confirmPassword: '' }));
      toast(mode === 'setup' ? '管理员账户已创建' : '登录成功');
    } catch (error) {
      setAuthError(error.message);
    } finally {
      setActionBusy(mode === 'setup' ? 'setup' : 'login', false);
    }
  }

  async function logout() {
    try {
      await api('/api/auth/logout', {
        method: 'POST',
        onUnauthorized: () => undefined
      });
    } catch (_error) {
      // Ignore logout network errors and still reset local auth.
    }
    setAuth((current) => ({ ...current, authenticated: false }));
    setTerminalFullscreenOpen(false);
    setStateLoaded(false);
    setSettingsDialogOpen(false);
  }

  async function saveAccount() {
    setAccountError('');
    if (!accountForm.currentPassword) {
      setAccountError('请输入当前密码');
      return;
    }
    if (accountForm.newPassword && accountForm.newPassword !== accountForm.confirmPassword) {
      setAccountError('两次新密码不一致');
      return;
    }

    try {
      setActionBusy('account', true);
      const data = await api('/api/auth/account', {
        method: 'POST',
        body: JSON.stringify({
          username: accountForm.username,
          currentPassword: accountForm.currentPassword,
          newPassword: accountForm.newPassword
        }),
        onUnauthorized: () => setAuth((current) => ({ ...current, authenticated: false }))
      });
      setAuth((current) => ({ ...current, username: data.username, authenticated: true }));
      setAccountForm((current) => ({
        ...current,
        username: data.username,
        currentPassword: '',
        newPassword: '',
        confirmPassword: ''
      }));
      setSettingsDialogOpen(false);
      toast('账户设置已更新');
    } catch (error) {
      setAccountError(error.message);
    } finally {
      setActionBusy('account', false);
    }
  }

  function resetCreateDraft(type) {
    if (type === 'server') {
      setServerDraft({ ...EMPTY_SERVER, groupId: state.groups[0]?.id || 'group-default' });
      setEditorDialog({ open: true, type: 'server', mode: 'create' });
    }
    if (type === 'command') {
      setCommandDraft({ ...EMPTY_COMMAND });
      setEditorDialog({ open: true, type: 'command', mode: 'create' });
    }
    if (type === 'proxy') {
      setProxyDraft({ ...EMPTY_PROXY });
      setEditorDialog({ open: true, type: 'proxy', mode: 'create' });
    }
  }

  function openEditor(type, item = null) {
    if (type === 'server') {
      const next = item ? { ...item } : { ...EMPTY_SERVER, groupId: state.groups[0]?.id || 'group-default' };
      setServerDraft(next);
      setSelectedServerId(next.id || '');
    }
    if (type === 'command') {
      const next = item ? { ...item } : { ...EMPTY_COMMAND };
      setCommandDraft(next);
      setSelectedCommandId(next.id || '');
    }
    if (type === 'proxy') {
      const next = item ? { ...item } : { ...EMPTY_PROXY };
      setProxyDraft(next);
      setSelectedProxyId(next.id || '');
    }
    setEditorDialog({ open: true, type, mode: item ? 'edit' : 'create' });
  }

  function closeEditor() {
    setEditorDialog((current) => ({ ...current, open: false, mode: 'edit' }));
    setShowServerPassword(false);
  }

  function requireSelectedItem(type) {
    if (type === 'server' && !selectedServer) {
      toast('请先选择服务器');
      return false;
    }
    if (type === 'command' && !state.commands.find((item) => item.id === selectedCommandId)) {
      toast('请先选择命令');
      return false;
    }
    if (type === 'proxy' && !selectedProxy) {
      toast('请先选择代理');
      return false;
    }
    return true;
  }

  useEffect(() => {
    if (!editorDialog.open || editorDialog.type !== 'server') {
      return;
    }
    setShowServerPassword(false);
    if (!serverDraft.id) {
      return;
    }
    let cancelled = false;
    api(`/api/servers/${serverDraft.id}/password`, {
      onUnauthorized: () => setAuth((current) => ({ ...current, authenticated: false }))
    })
      .then((data) => {
        if (cancelled) {
          return;
        }
        setServerDraft((current) => (current.id === serverDraft.id ? { ...current, password: data.password || '' } : current));
      })
      .catch((error) => {
        if (!cancelled) {
          toast(error.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [editorDialog.open, editorDialog.type, serverDraft.id]);

  async function saveServer() {
    try {
      setActionBusy('saveServer', true);
      const payload = { ...serverDraft, port: Number(serverDraft.port) || 22 };
      const data = await api(serverDraft.id ? `/api/servers/${serverDraft.id}` : '/api/servers', {
        method: serverDraft.id ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
        onUnauthorized: () => setAuth((current) => ({ ...current, authenticated: false }))
      });
      setState(data.state);
      setSelectedServerId(serverDraft.id || data.item?.id || '');
      closeEditor();
      toast(serverDraft.id ? '服务器已保存' : '服务器已新增');
    } catch (error) {
      toast(error.message);
    } finally {
      setActionBusy('saveServer', false);
    }
  }

  async function removeServer(ids = []) {
    const targetIds = Array.isArray(ids) && ids.length
      ? ids
      : (selectedServerId ? [selectedServerId] : []);
    if (!targetIds.length) {
      return;
    }
    try {
      let nextState = state;
      for (const id of targetIds) {
        const data = await api(`/api/servers/${id}`, {
          method: 'DELETE',
          onUnauthorized: () => setAuth((current) => ({ ...current, authenticated: false }))
        });
        nextState = data.state;
      }
      setState(nextState);
      if (targetIds.includes(selectedServerId)) {
        setSelectedServerId(nextState.servers[0]?.id || '');
      }
      closeEditor();
      toast(targetIds.length === 1 ? '服务器已删除' : `已删除 ${targetIds.length} 台服务器`);
    } catch (error) {
      toast(error.message);
    }
  }

  async function saveCommand() {
    try {
      setActionBusy('saveCommand', true);
      const payload = { ...commandDraft, command: commandDraft.command || commandText };
      const data = await api(commandDraft.id ? `/api/commands/${commandDraft.id}` : '/api/commands', {
        method: commandDraft.id ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
        onUnauthorized: () => setAuth((current) => ({ ...current, authenticated: false }))
      });
      setState(data.state);
      setSelectedCommandId(commandDraft.id || data.item?.id || '');
      closeEditor();
      toast(commandDraft.id ? '命令已保存' : '命令已新增');
    } catch (error) {
      toast(error.message);
    } finally {
      setActionBusy('saveCommand', false);
    }
  }

  async function removeCommand(ids = []) {
    const targetIds = Array.isArray(ids) && ids.length
      ? ids
      : (selectedCommandId ? [selectedCommandId] : []);
    if (!targetIds.length) {
      return;
    }
    try {
      let nextState = state;
      for (const id of targetIds) {
        const data = await api(`/api/commands/${id}`, {
          method: 'DELETE',
          onUnauthorized: () => setAuth((current) => ({ ...current, authenticated: false }))
        });
        nextState = data.state;
      }
      setState(nextState);
      if (targetIds.includes(selectedCommandId)) {
        setSelectedCommandId(nextState.commands[0]?.id || '');
      }
      setExecutionResults([]);
      closeEditor();
      toast(targetIds.length === 1 ? '命令已删除' : `已删除 ${targetIds.length} 条命令`);
    } catch (error) {
      toast(error.message);
    }
  }

  async function saveProxy() {
    try {
      setActionBusy('saveProxy', true);
      const payload = { ...proxyDraft, port: Number(proxyDraft.port) || 1080 };
      const data = await api(proxyDraft.id ? `/api/proxies/${proxyDraft.id}` : '/api/proxies', {
        method: proxyDraft.id ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
        onUnauthorized: () => setAuth((current) => ({ ...current, authenticated: false }))
      });
      setState(data.state);
      setSelectedProxyId(proxyDraft.id || data.item?.id || '');
      closeEditor();
      toast(proxyDraft.id ? '代理已保存' : '代理已新增');
    } catch (error) {
      toast(error.message);
    } finally {
      setActionBusy('saveProxy', false);
    }
  }

  async function removeProxy(ids = []) {
    const targetIds = Array.isArray(ids) && ids.length
      ? ids
      : (selectedProxyId ? [selectedProxyId] : []);
    if (!targetIds.length) {
      return;
    }
    try {
      let nextState = state;
      for (const id of targetIds) {
        const data = await api(`/api/proxies/${id}`, {
          method: 'DELETE',
          onUnauthorized: () => setAuth((current) => ({ ...current, authenticated: false }))
        });
        nextState = data.state;
      }
      setState(nextState);
      if (targetIds.includes(selectedProxyId)) {
        setSelectedProxyId(nextState.proxies[0]?.id || '');
      }
      closeEditor();
      toast(targetIds.length === 1 ? '代理已删除' : `已删除 ${targetIds.length} 个代理`);
    } catch (error) {
      toast(error.message);
    }
  }

  function confirmSidebarDelete(type) {
    if (type === 'server') {
      const targetIds = selectedServerId ? [selectedServerId] : state.servers.map((item) => item.id);
      if (!targetIds.length) {
        toast('暂无可删除服务器');
        return;
      }
      openConfirm({
        title: selectedServerId ? '删除服务器' : '全部删除服务器',
        message: selectedServerId
          ? '确认删除当前服务器吗？'
          : `当前未选择服务器，确认删除全部 ${targetIds.length} 台服务器吗？`,
        onConfirm: () => removeServer(targetIds)
      });
      return;
    }

    if (type === 'command') {
      const targetIds = selectedCommandId ? [selectedCommandId] : state.commands.map((item) => item.id);
      if (!targetIds.length) {
        toast('暂无可删除命令');
        return;
      }
      openConfirm({
        title: selectedCommandId ? '删除命令' : '全部删除命令',
        message: selectedCommandId
          ? '确认删除当前命令吗？'
          : `当前未选择命令，确认删除全部 ${targetIds.length} 条命令吗？`,
        onConfirm: () => removeCommand(targetIds)
      });
      return;
    }

    if (type === 'proxy') {
      const targetIds = selectedProxyId ? [selectedProxyId] : state.proxies.map((item) => item.id);
      if (!targetIds.length) {
        toast('暂无可删除代理');
        return;
      }
      openConfirm({
        title: selectedProxyId ? '删除代理' : '全部删除代理',
        message: selectedProxyId
          ? '确认删除当前代理吗？'
          : `当前未选择代理，确认删除全部 ${targetIds.length} 个代理吗？`,
        onConfirm: () => removeProxy(targetIds)
      });
    }
  }

  async function saveGroup() {
    try {
      setActionBusy('saveGroup', true);
      const current = groupDialog.value;
      const data = await api(current.id ? `/api/groups/${current.id}` : '/api/groups', {
        method: current.id ? 'PUT' : 'POST',
        body: JSON.stringify(current),
        onUnauthorized: () => setAuth((currentAuth) => ({ ...currentAuth, authenticated: false }))
      });
      setState(data.state);
      setGroupDialog({ open: false, value: EMPTY_GROUP });
      toast(current.id ? '分组已保存' : '分组已新增');
    } catch (error) {
      toast(error.message);
    } finally {
      setActionBusy('saveGroup', false);
    }
  }

  async function removeGroup(id) {
    if (!id) {
      return;
    }
    try {
      const data = await api(`/api/groups/${id}`, {
        method: 'DELETE',
        onUnauthorized: () => setAuth((current) => ({ ...current, authenticated: false }))
      });
      setState(data.state);
      toast('分组已删除');
    } catch (error) {
      toast(error.message);
    }
  }

  async function previewImport() {
    setImportDialog((current) => ({ ...current, loading: true, confirmOverwrite: false }));
    try {
      setActionBusy('previewImport', true);
      const data = await api('/api/import/preview', {
        method: 'POST',
        body: JSON.stringify({ text: importDialog.text }),
        onUnauthorized: () => setAuth((current) => ({ ...current, authenticated: false }))
      });
      setImportDialog((current) => ({ ...current, loading: false, preview: data }));
    } catch (error) {
      setImportDialog((current) => ({ ...current, loading: false }));
      toast(error.message);
    } finally {
      setActionBusy('previewImport', false);
    }
  }

  async function applyImport(overwriteDuplicates) {
    const items = importDialog.preview?.items || [];
    if (!items.length) {
      return;
    }
    try {
      setActionBusy(overwriteDuplicates ? 'applyImportOverwrite' : 'applyImport', true);
      const data = await api('/api/import/apply', {
        method: 'POST',
        body: JSON.stringify({ items, overwriteDuplicates }),
        onUnauthorized: () => setAuth((current) => ({ ...current, authenticated: false }))
      });
      setState(data.state);
      setImportDialog({ open: false, text: '', preview: null, confirmOverwrite: false, loading: false });
      toast(overwriteDuplicates ? '重复服务器已覆盖导入' : '服务器已导入');
    } catch (error) {
      toast(error.message);
    } finally {
      setActionBusy(overwriteDuplicates ? 'applyImportOverwrite' : 'applyImport', false);
    }
  }

  function openRunCommandConfirm() {
    if (!canRunCommand || busy.runCommand) {
      return;
    }
    setRunCommandConfirmOpen(true);
    setTemporaryKeywordsDialogOpen(false);
    setTemporaryInteractiveKeywordsText('');
  }

  async function runCommand(overrideInteractiveKeywords = interactiveKeywords) {
    if (!selectedServerIds.length) {
      toast('请先选择至少一台服务器');
      return;
    }
    const nextInteractiveKeywords = sanitizeInteractiveKeywords(overrideInteractiveKeywords, { fallbackToDefault: false });
    try {
      setActionBusy('runCommand', true);
      setRunCommandConfirmOpen(false);
      setTemporaryKeywordsDialogOpen(false);
      setHandledBatchInputSignature('');
      setBatchInputDialog(EMPTY_BATCH_INPUT_DIALOG);
      setResultTerminalServerId('');
      setCommandInteractiveKeywords(nextInteractiveKeywords);
      const data = await api('/api/commands/execute', {
        method: 'POST',
        body: JSON.stringify({
          serverIds: selectedServerIds,
          commandId: selectedCommandId,
          commandText,
          interactiveKeywords: nextInteractiveKeywords
        }),
        onUnauthorized: () => setAuth((current) => ({ ...current, authenticated: false }))
      });
      setExecutionResults(data.results || []);
      setLastExecutedCommand(data.command || commandText.trim());
      setCommandJobId(data.jobId || '');
      setCommandInteractiveKeywords(sanitizeInteractiveKeywords(data.interactiveKeywords, { fallbackToDefault: false }));
      setCommandJobStatus('running');
      toast(`已开始执行 ${data.results.length} 台服务器`);
    } catch (error) {
      toast(error.message);
      setActionBusy('runCommand', false);
    }
  }

  async function clearCommandResults() {
    if (!canClearCommandResults) {
      return;
    }
    try {
      setActionBusy('clearCommandResults', true);
      if (commandJobId && isCommandRunning) {
        await api(`/api/commands/jobs/${commandJobId}/cancel`, {
          method: 'POST',
          body: JSON.stringify({}),
          onUnauthorized: () => setAuth((current) => ({ ...current, authenticated: false }))
        });
      }
      setExecutionResults([]);
      setLastExecutedCommand('');
      setCommandJobId('');
      setCommandInteractiveKeywords(interactiveKeywords);
      setCommandJobStatus('idle');
      setHandledBatchInputSignature('');
      setBatchInputDialog(EMPTY_BATCH_INPUT_DIALOG);
      setBusy((current) => ({ ...current, runCommand: false }));
      toast(isCommandRunning ? '已发送 Ctrl+C 并清空当前执行任务' : '执行结果已清空');
    } catch (error) {
      toast(error.message);
    } finally {
      setActionBusy('clearCommandResults', false);
    }
  }

  function toggleServerChecked(serverId) {
    setSelectedServerIds((current) =>
      current.includes(serverId) ? current.filter((id) => id !== serverId) : [...current, serverId]
    );
  }

  function openTerminal(serverItem, options = {}) {
    if (!serverItem) {
      return null;
    }
    const { fullscreen = false } = options;
    const nextInstanceNo = terminalSessions
      .filter((item) => item.serverId === serverItem.id)
      .reduce((max, item) => Math.max(max, Number.isInteger(item.instanceNo) ? item.instanceNo : -1), -1) + 1;
    const session = {
      id: crypto.randomUUID(),
      serverId: serverItem.id,
      instanceNo: nextInstanceNo,
      title: formatTerminalSessionTitle(serverItem.name, nextInstanceNo)
    };
    setTerminalSessions((current) => [...current, session]);
    setActiveTerminalId(session.id);
    if (fullscreen) {
      setTerminalFullscreenOpen(true);
    }
    return session;
  }

  function openResultTerminalByServerId(serverId) {
    if (!serverId) {
      return;
    }
    setTerminalFullscreenOpen(false);
    setResultTerminalServerId(serverId);
  }

  function openResultTerminal(resultItem) {
    openResultTerminalByServerId(resultItem?.serverId || '');
  }

  function closeBatchInputDialog() {
    setBatchInputDialog(EMPTY_BATCH_INPUT_DIALOG);
  }

  function openBroadcastInputDialog() {
    setBatchInputDialog((current) => ({
      ...current,
      open: true,
      mode: batchInputReady ? 'broadcast' : 'wait',
      value: current.mode === 'broadcast' ? current.value : '',
      awaitingServerIds: awaitingInputResults.map((item) => item.serverId),
      signature: awaitingInputSignature
    }));
  }

  function chooseBatchInputIndividually(serverId) {
    if (!batchInputReady) {
      return;
    }
    const firstServerId = serverId || batchInputDialog.awaitingServerIds[0] || awaitingInputResults[0]?.serverId || '';
    closeBatchInputDialog();
    if (firstServerId) {
      openResultTerminalByServerId(firstServerId);
      toast('已切换为逐台输入，继续点击结果卡片即可进入对应服务器会话。');
    }
  }

  async function submitBatchInput() {
    if (!batchInputReady || !commandJobId || !batchInputDialog.awaitingServerIds.length) {
      closeBatchInputDialog();
      return;
    }
    try {
      setActionBusy('submitBatchInput', true);
      const data = await api(`/api/commands/jobs/${commandJobId}/input`, {
        method: 'POST',
        body: JSON.stringify({
          serverIds: batchInputDialog.awaitingServerIds,
          data: batchInputDialog.value
        }),
        onUnauthorized: () => setAuth((current) => ({ ...current, authenticated: false }))
      });
      closeBatchInputDialog();
      toast(`已向 ${data.sent || 0} 台服务器发送输入`);
    } catch (error) {
      toast(error.message);
    } finally {
      setActionBusy('submitBatchInput', false);
    }
  }

  function saveInteractiveKeywords() {
    setInteractiveKeywords(parseInteractiveKeywordsText(interactiveKeywordsText));
    setInteractiveKeywordsDialogOpen(false);
    toast('交互规则已保存');
  }

  async function runCommandWithGlobalKeywords() {
    await runCommand(interactiveKeywords);
  }

  function openTemporaryInteractiveKeywordsDialog() {
    setRunCommandConfirmOpen(false);
    setTemporaryKeywordsDialogOpen(true);
    setTemporaryInteractiveKeywordsText('');
  }

  async function runCommandWithTemporaryKeywords() {
    await runCommand(parseInteractiveKeywordsText(temporaryInteractiveKeywordsText, { fallbackToDefault: false }));
  }

  function openServerPicker() {
    setServerPickerMode('command');
    setPickerSearch('');
    setPickerGroupId('all');
    setPickerSelectedIds(selectedServerIds);
    setServerPickerOpen(true);
  }

  function openProxyServerPicker() {
    if (!requireSelectedItem('proxy')) {
      return;
    }
    setServerPickerMode('proxy');
    setPickerSearch('');
    setPickerGroupId('all');
    setPickerSelectedIds([]);
    setServerPickerOpen(true);
  }

  function toggleGroupChecked(groupId) {
    const ids = state.servers.filter((item) => item.groupId === groupId).map((item) => item.id);
    const fullySelected = ids.length > 0 && ids.every((id) => pickerSelectedIds.includes(id));
    setPickerSelectedIds((current) => {
      if (fullySelected) {
        return current.filter((id) => !ids.includes(id));
      }
      return Array.from(new Set([...current, ...ids]));
    });
  }

  function selectAllServers() {
    setPickerSelectedIds(state.servers.map((item) => item.id));
  }

  function selectCurrentPickerGroup() {
    const ids = pickerFilteredServers.map((item) => item.id);
    setPickerSelectedIds((current) => Array.from(new Set([...current, ...ids])));
  }

  function clearCurrentPickerGroup() {
    const ids = new Set(pickerFilteredServers.map((item) => item.id));
    setPickerSelectedIds((current) => current.filter((id) => !ids.has(id)));
  }

  function togglePickerServerChecked(serverId) {
    setPickerSelectedIds((current) =>
      current.includes(serverId) ? current.filter((id) => id !== serverId) : [...current, serverId]
    );
  }

  async function applySelectedServersToProxy() {
    if (!selectedProxy) {
      toast('请先选择代理');
      return;
    }
    if (!pickerSelectedIds.length) {
      toast('请先选择至少一台服务器');
      return;
    }

    try {
      setActionBusy('applyProxyServers', true);
      const data = await api(`/api/proxies/${selectedProxy.id}/assign`, {
        method: 'POST',
        body: JSON.stringify({ serverIds: pickerSelectedIds }),
        onUnauthorized: () => setAuth((current) => ({ ...current, authenticated: false }))
      });
      setState(data.state);
      setServerPickerOpen(false);
      setPickerSelectedIds([]);
      toast(`已应用到 ${pickerSelectedIds.length} 台服务器`);
    } catch (error) {
      toast(error.message);
    } finally {
      setActionBusy('applyProxyServers', false);
    }
  }

  async function unassignProxyServers(serverIds = [], clearAll = false) {
    if (!selectedProxy) {
      toast('请先选择代理');
      return;
    }
    if (!clearAll && !serverIds.length) {
      return;
    }

    try {
      setActionBusy(clearAll ? 'clearAllProxyServers' : `unassignProxy:${serverIds.join(',')}`, true);
      const data = await api(`/api/proxies/${selectedProxy.id}/unassign`, {
        method: 'POST',
        body: JSON.stringify({ serverIds, clearAll }),
        onUnauthorized: () => setAuth((current) => ({ ...current, authenticated: false }))
      });
      setState(data.state);
      toast(clearAll ? '已全部取消' : '已取消应用');
    } catch (error) {
      toast(error.message);
    } finally {
      setActionBusy(clearAll ? 'clearAllProxyServers' : `unassignProxy:${serverIds.join(',')}`, false);
    }
  }

  async function confirmServerPicker() {
    if (serverPickerMode === 'command') {
      setSelectedServerIds(pickerSelectedIds);
      setServerPickerOpen(false);
      return;
    }

    await applySelectedServersToProxy();
  }

  function closeTerminal(sessionId) {
    setTerminalSessions((current) => {
      const closingIndex = current.findIndex((item) => item.id === sessionId);
      if (closingIndex === -1) {
        return current;
      }
      const nextSessions = current.filter((item) => item.id !== sessionId);
      if (activeTerminalId === sessionId) {
        const fallbackSession = nextSessions[closingIndex] || nextSessions[closingIndex - 1] || null;
        setActiveTerminalId(fallbackSession?.id || '');
      }
      return nextSessions;
    });
  }

  function closeAllTerminals() {
    setTerminalSessions([]);
    setActiveTerminalId('');
    setTerminalFullscreenOpen(false);
  }

  if (auth.loading) {
    return (
      <div className="auth-shell">
        <div className="auth-card loading-card">
          <div className="brand-mark">N</div>
          <strong>NuroSSH</strong>
          <span>正在加载控制台</span>
        </div>
      </div>
    );
  }

  if (!auth.configured || !auth.authenticated) {
    const isSetup = !auth.configured;
    return (
      <div className="auth-shell">
        <div className="auth-backdrop" />
        <div className="auth-layout">
          <section className="auth-panel">
            <div className="auth-brand">
              <div className="brand-mark">N</div>
              <div>
                <strong>NuroSSH</strong>
                <span>Secure server workspace</span>
              </div>
            </div>
            <div className="auth-copy">
              <span className="label-chip">{isSetup ? '首次初始化' : '管理员登录'}</span>
              <h1>{isSetup ? '创建管理员账号' : '登录 NuroSSH'}</h1>
              <p>{isSetup ? '初始化完成后进入工作台。' : '登录后进入工作台。'}</p>
            </div>
            <div className="auth-grid">
              <div className="auth-kpi">
                <strong>SSH</strong>
                <span>浏览器终端</span>
              </div>
              <div className="auth-kpi">
                <strong>Batch</strong>
                <span>批量命令执行</span>
              </div>
              <div className="auth-kpi">
                <strong>Proxy</strong>
                <span>代理接入</span>
              </div>
            </div>
          </section>

          <section className="auth-form-card">
            <div className="auth-form-head">
              <strong>{isSetup ? '创建管理员账户' : '登录 NuroSSH'}</strong>
              <span>{isSetup ? '密码至少 4 位' : '输入账号和密码'}</span>
            </div>

            <div className="field-grid single">
              <Field label="用户名">
                <input
                  value={authForm.username}
                  onChange={(event) => setAuthForm((current) => ({ ...current, username: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void submitAuth(isSetup ? 'setup' : 'login');
                    }
                  }}
                  placeholder="输入用户名"
                />
              </Field>
              <Field label="密码">
                <input
                  type="password"
                  value={authForm.password}
                  onChange={(event) => setAuthForm((current) => ({ ...current, password: event.target.value }))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void submitAuth(isSetup ? 'setup' : 'login');
                    }
                  }}
                  placeholder="输入密码"
                />
              </Field>
              {isSetup ? (
                <Field label="确认密码">
                  <input
                    type="password"
                    value={authForm.confirmPassword}
                    onChange={(event) => setAuthForm((current) => ({ ...current, confirmPassword: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void submitAuth(isSetup ? 'setup' : 'login');
                      }
                    }}
                    placeholder="再次输入密码"
                  />
                </Field>
              ) : null}
            </div>

              {authError ? <div className="auth-error">{authError}</div> : null}

              <button
                type="submit"
                className={'primary auth-submit ' + (busy[isSetup ? 'setup' : 'login'] ? 'is-loading' : '')}
                disabled={busy[isSetup ? 'setup' : 'login']}
              >
              {busy[isSetup ? 'setup' : 'login'] ? '处理中...' : (isSetup ? '创建并进入控制台' : '登录')}
            </button>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className={'console-shell ' + (workspaceFullscreenActive ? 'console-shell-terminal-fullscreen' : '')}>
      <header className={'console-topbar ' + (workspaceFullscreenActive ? 'console-topbar-hidden' : '')}>
        <div className="brand-cluster">
          <div className="brand-mark">N</div>
          <div>
            <strong>NuroSSH</strong>
            <span>Server workspace</span>
          </div>
        </div>

        <nav className="top-tabs">
          {TABS.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.key} className={'top-tab ' + (tab === item.key ? 'active' : '')} onClick={() => setTab(item.key)}>
                <Icon />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="top-actions">
          <div className="search-shell">
            <SearchIcon />
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={searchPlaceholder} />
          </div>
          <button
            className="ghost theme-toggle"
            title={theme === 'nuro-dark' ? '切换到 HBX 护眼主题' : '切换到深色主题'}
            onClick={() => setTheme((current) => (current === 'nuro-dark' ? 'hbx-light' : 'nuro-dark'))}
          >
            <ThemeIcon theme={theme} />
          </button>
          <button className="ghost mobile-only" onClick={() => setAssetDrawerOpen((value) => !value)}>列表</button>
          {tab === 'servers' ? <button className="ghost" onClick={() => setImportDialog((current) => ({ ...current, open: true }))}>导入</button> : null}
          <button className="ghost user-pill" onClick={() => setSettingsDialogOpen(true)}>
            <GearIcon />
            <span>设置</span>
          </button>
        </div>
      </header>

      <div className={'console-body ' + (workspaceFullscreenActive ? 'console-body-terminal-fullscreen' : '')}>
        <aside className={'surface side-panel ' + (assetDrawerOpen ? 'open' : '') + ' ' + (workspaceFullscreenActive ? 'side-panel-hidden' : '')}>
          <div className="side-head">
            <div>
              <strong>{tab === 'servers' ? '资产树' : tab === 'commands' ? '命令模板' : '代理列表'}</strong>
              <span>
                {tab === 'servers'
                  ? `${state.servers.length} 台服务器`
                  : tab === 'commands'
                    ? `${state.commands.length} 条命令`
                    : `${state.proxies.length} 个代理`}
              </span>
            </div>
            <div className="toolbar">
              {tab === 'servers' ? (
                <>
                  <button className="ghost" onClick={() => {
                    if (requireSelectedItem('server')) {
                      openEditor('server', selectedServer);
                    }
                  }}>编辑</button>
                  <button className="primary" onClick={() => resetCreateDraft('server')}>新增</button>
                  <button className="ghost danger-text-button" onClick={() => confirmSidebarDelete('server')}>删除</button>
                </>
              ) : null}
              {tab === 'commands' ? (
                <>
                  <button className="ghost" onClick={() => {
                    if (requireSelectedItem('command')) {
                      openEditor('command', selectedCommand);
                    }
                  }}>编辑</button>
                  <button className="primary" onClick={() => resetCreateDraft('command')}>新增</button>
                  <button className="ghost danger-text-button" onClick={() => confirmSidebarDelete('command')}>删除</button>
                </>
              ) : null}
              {tab === 'proxies' ? (
                <>
                  <button className="ghost" onClick={() => {
                    if (requireSelectedItem('proxy')) {
                      openEditor('proxy', selectedProxy);
                    }
                  }}>编辑</button>
                  <button className="primary" onClick={() => resetCreateDraft('proxy')}>新增</button>
                  <button className="ghost danger-text-button" onClick={() => confirmSidebarDelete('proxy')}>删除</button>
                </>
              ) : null}
            </div>
          </div>

          {tab === 'servers' ? (
            <div className="panel-scroll">
              {state.groups.map((group) => {
                const items = filteredServers.filter((serverItem) => serverItem.groupId === group.id);
                const collapsed = collapsedGroups[group.id];
                return (
                  <div key={group.id} className="tree-group">
                    <div className="tree-group-head">
                      <button className="tree-group-button" onClick={() => setCollapsedGroups((current) => ({ ...current, [group.id]: !current[group.id] }))}>
                        <ChevronIcon collapsed={collapsed} />
                        <strong>{group.name}</strong>
                        <span>{items.length}</span>
                      </button>
                      <div className="row-actions">
                        <button className="icon-button" onClick={() => setGroupDialog({ open: true, value: { ...group } })}><EditIcon /></button>
                        {group.id !== 'group-default' ? (
                          <button className="icon-button danger" onClick={() => openConfirm({
                            title: '删除分组',
                            message: '确认删除当前分组吗？分组下服务器会自动回到默认分组。',
                            onConfirm: () => removeGroup(group.id)
                          })}><TrashIcon /></button>
                        ) : null}
                      </div>
                    </div>

                    {!collapsed ? (
                      <div className="tree-list">
                        {items.length ? (
                          items.map((serverItem) => (
                            <div
                              key={serverItem.id}
                              className={'tree-item ' + (selectedServerId === serverItem.id ? 'selected' : '')}
                              onClick={() => {
                                setSelectedServerId(serverItem.id);
                              }}
                            >
                              <div className="tree-copy">
                                <strong>{serverItem.name}</strong>
                                <span>{serverItem.host}:{serverItem.port}</span>
                              </div>
                              <div className="tree-actions">
                                {serverItem.proxyId ? <em>代理</em> : null}
                                <button
                                  className="icon-button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    openEditor('server', serverItem);
                                  }}
                                >
                                  <EditIcon />
                                </button>
                                <button
                                  className="icon-button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    openTerminal(serverItem);
                                  }}
                                >
                                  <PlayIcon />
                                </button>
                              </div>
                            </div>
                          ))
                        ) : (
                          <div className="empty-line">这个分组下没有服务器</div>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {tab === 'commands' ? (
            <div className="panel-scroll stack-list">
              {filteredCommands.map((item) => (
                <button
                  key={item.id}
                  className={'stack-card ' + (selectedCommandId === item.id ? 'selected' : '')}
                  onClick={() => {
                    setSelectedCommandId(item.id);
                    setCommandText(item.command);
                  }}
                >
                  <strong>{item.name}</strong>
                </button>
              ))}
            </div>
          ) : null}

          {tab === 'proxies' ? (
            <div className="panel-scroll stack-list">
              {filteredProxies.map((item) => (
                <button
                  key={item.id}
                  className={'stack-card ' + (selectedProxyId === item.id ? 'selected' : '')}
                  onClick={() => {
                    setSelectedProxyId(item.id);
                  }}
                >
                  <strong>{item.name}</strong>
                </button>
              ))}
            </div>
          ) : null}
        </aside>

        <main className={'main-column ' + (workspaceFullscreenActive ? 'main-column-terminal-fullscreen' : '')}>
          <section className={'surface workspace-panel ' + (tab === 'servers' ? '' : 'workspace-panel-hidden') + ' ' + (workspaceFullscreenActive ? 'workspace-panel-terminal-fullscreen' : '')}>
              {!workspaceFullscreenActive ? <div className="workspace-head">
                <div>
                  <strong>终端工作区</strong>
                  <span>会话</span>
                </div>
                <div className="toolbar">
                  {!activeTerminal && selectedServer ? <button className="ghost" onClick={() => openEditor('server', selectedServer)}>编辑当前服务器</button> : null}
                  {terminalSessions.length ? <button className="ghost danger-text-button" onClick={closeAllTerminals}>清除会话</button> : null}
                </div>
              </div> : null}

              {!workspaceFullscreenActive && terminalSessions.length ? <SessionTabs
                sessions={terminalSessions}
                activeId={activeTerminalId}
                onSelect={setActiveTerminalId}
                onClose={closeTerminal}
              /> : null}

              <div className="workspace-stage">
                {terminalSessions.length ? (
                  <TerminalSessionDeck
                    sessions={terminalSessions}
                    activeId={activeTerminalId}
                    theme={theme}
                    commands={state.commands}
                    fullscreenId={terminalFullscreenOpen ? activeTerminalId : ''}
                    isVisible={tab === 'servers'}
                    onEnterFullscreen={(sessionId) => {
                      setActiveTerminalId(sessionId);
                      setTerminalFullscreenOpen(true);
                    }}
                    onExitFullscreen={() => setTerminalFullscreenOpen(false)}
                  />
                ) : (
                  <ServerOverview
                    selectedServer={selectedServer}
                    state={state}
                    selectedServerIds={selectedServerIds}
                    openTerminal={openTerminal}
                    onCreateServer={() => resetCreateDraft('server')}
                    onImport={() => setImportDialog((current) => ({ ...current, open: true }))}
                    onCreateGroup={() => setGroupDialog({ open: true, value: EMPTY_GROUP })}
                  />
                )}
              </div>
            </section>

          {tab === 'commands' ? (
            <section className="command-board">
              <div className="surface command-composer">
                <div className="workspace-head">
                  <div>
                    <strong>批量执行中心</strong>
                    <span>命令</span>
                  </div>
                  <button className={`primary ${busy.runCommand ? 'is-loading' : ''}`} onClick={openRunCommandConfirm} disabled={!canRunCommand || busy.runCommand}>
                    {busy.runCommand ? '执行中...' : '执行到已选服务器'}
                  </button>
                </div>
                <textarea
                  rows={7}
                  value={commandText}
                  onChange={(event) => setCommandText(event.target.value)}
                  placeholder="例如：systemctl status nginx && df -h"
                />
              </div>

              <div className="surface command-target-board">
                <div className="workspace-head">
                  <div>
                    <strong>执行目标</strong>
                    <span>{selectedServerIds.length ? ('已选 ' + selectedServerIds.length + ' 台') : '未选择'}</span>
                  </div>
                  <div className="toolbar">
                    <button className="ghost" onClick={openServerPicker} disabled={isCommandRunning}>选择服务器</button>
                    <button className="ghost" onClick={() => setSelectedServerIds([])} disabled={isCommandRunning || !selectedServerIds.length}>清空</button>
                  </div>
                </div>
                <div className="target-summary">
                  <strong>{selectedServerIds.length}</strong>
                  <span>{selectedServerIds.length ? '已选执行目标' : '使用大弹窗选择服务器、分组或全选'}</span>
                </div>
              </div>

              <div className="surface command-result-board">
                <div className="workspace-head">
                  <div>
                    <strong>执行结果</strong>
                    <span>
                      {commandProgress.total
                        ? '已出结果 ' + resolvedCommandResultCount + ' / ' + commandProgress.total + (pendingCommandResultCount ? ('，等待 ' + pendingCommandResultCount + ' 台') : '')
                        : '结果'}
                    </span>
                  </div>
                  <div className="toolbar">
                    <button className="ghost" onClick={() => setInteractiveKeywordsDialogOpen(true)}>
                      交互规则
                    </button>
                    {awaitingInputResults.length ? (
                      <button className="ghost" onClick={openBroadcastInputDialog} disabled={!batchInputReady}>
                        {batchInputReady ? '统一输入' : ('等待结果 ' + resolvedCommandResultCount + '/' + commandProgress.total)}
                      </button>
                    ) : null}
                    <button className={'ghost ' + (busy.clearCommandResults ? 'is-loading' : '')} onClick={clearCommandResults} disabled={!canClearCommandResults || busy.clearCommandResults}>
                      {isCommandRunning ? '取消并清空' : '清空'}
                    </button>
                  </div>
                </div>
                <div className="result-list">
                  {executionResults.length ? (
                    executionResults.map((item) => (
                      <article
                        key={item.serverId}
                        className={
                          'result-card result-card-actionable ' +
                          ((!item.ok && item.status !== 'queued' && item.status !== 'running' && item.status !== 'awaiting_input') ? 'error ' : '') +
                          ((item.status === 'running' || item.status === 'queued' || item.status === 'awaiting_input') ? 'running' : '')
                        }
                        onClick={() => openResultTerminal(item)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            openResultTerminal(item);
                          }
                        }}
                        role="button"
                        tabIndex={0}
                      >
                        <div className="result-head">
                          <div>
                            <strong>{item.name}</strong>
                            <span>{item.host}</span>
                          </div>
                          <em>
                            {item.status === 'queued' || item.status === 'running'
                              ? '执行中'
                              : item.status === 'awaiting_input'
                                ? '等待输入'
                              : item.ok
                                ? ('Exit ' + (item.exitCode ?? 0))
                                : '失败'}
                          </em>
                        </div>
                        <div className="result-tip">
                          {item.status === 'awaiting_input'
                            ? '这台服务器正在等待输入，点击后可以直接进入真实会话继续输入。'
                            : '点击直接打开当前执行会话'}
                        </div>
                        {(item.status === 'queued' || item.status === 'running') ? (
                          <>
                            <div className="result-pending">
                              <span className="spinner" />
                              <span>执行中，正在实时显示当前 SSH 输出...</span>
                            </div>
                            {(item.stdout || item.stderr || item.error) ? (
                              <AutoScrollPre text={item.error ? item.error : cleanTerminalOutput([item.stdout, item.stderr].filter(Boolean).join('\n'))} />
                            ) : null}
                          </>
                        ) : item.status === 'awaiting_input' ? (
                          <>
                            <div className="result-pending">
                              <span className="spinner" />
                              <span>脚本正在等待输入，你可以统一输入，也可以逐台进入处理。</span>
                            </div>
                            <AutoScrollPre text={item.error ? item.error : cleanTerminalOutput([item.stdout, item.stderr].filter(Boolean).join('\n'))} />
                          </>
                        ) : (
                          <AutoScrollPre text={item.error ? item.error : cleanTerminalOutput([item.stdout, item.stderr].filter(Boolean).join('\n'))} />
                        )}
                      </article>
                    ))
                  ) : (
                    <div className="empty-state result-empty">暂无</div>
                  )}
                </div>
              </div>
            </section>
          ) : null}

          {tab === 'proxies' ? (
            <section className="proxy-board">
              <div className="surface proxy-hero">
                <span className="label-chip">代理绑定</span>
                <strong>{selectedProxy ? selectedProxy.name : '代理工作区'}</strong>
                <p>{selectedProxy ? (selectedProxy.type.toUpperCase() + ' 路 ' + selectedProxy.host + ':' + selectedProxy.port) : 'SOCKS5 / HTTP CONNECT'}</p>
                <div className="hero-actions">
                  <button className="primary" onClick={openProxyServerPicker}>选择服务器快速应用</button>
                  <button
                    className={'ghost ' + (busy.clearAllProxyServers ? 'is-loading' : '')}
                    onClick={() => openConfirm({
                      title: '全部取消',
                      message: '确认取消当前代理绑定的全部服务器吗？',
                      onConfirm: () => unassignProxyServers([], true)
                    })}
                    disabled={!selectedProxy || !proxyUsage.length || busy.clearAllProxyServers}
                  >
                    {busy.clearAllProxyServers ? '取消中...' : '全部取消'}
                  </button>
                </div>
              </div>

              <div className="surface proxy-usage-board">
                <div className="workspace-head">
                  <div>
                    <strong>{selectedProxy ? '使用范围' : '代理列表'}</strong>
                    <span>{selectedProxy ? (proxyUsage.length + ' 台') : '未选择'}</span>
                  </div>
                </div>
                <div className="usage-list">
                  {selectedProxy ? (
                    proxyUsage.length ? (
                      proxyUsage.map((item) => (
                        <div key={item.id} className="usage-card">
                          <div>
                            <strong>{item.name}</strong>
                            <span>{item.host}:{item.port}</span>
                          </div>
                          <button
                            className={'ghost mini-remove ' + (busy['unassignProxy:' + item.id] ? 'is-loading' : '')}
                            onClick={() => openConfirm({
                              title: '取消代理应用',
                                message: '确认取消 ' + item.name + ' 的代理绑定吗？',
                              onConfirm: () => unassignProxyServers([item.id])
                            })}
                            disabled={busy['unassignProxy:' + item.id]}
                          >
                            {busy['unassignProxy:' + item.id] ? '取消中...' : '×'}
                          </button>
                        </div>
                      ))
                    ) : (
                      <div className="empty-state usage-empty">当前代理还没有绑定任何服务器。</div>
                    )
                  ) : (
                    <div className="empty-state usage-empty">从左侧选中一个代理后，这里会列出使用它的服务器。</div>
                  )}
                </div>
              </div>
            </section>
          ) : null}
        </main>

      </div>

      {editorDialog.open && editorDialog.type === 'server' ? (
        <Dialog
          title={serverDraft.id ? '编辑服务器' : '新增服务器'}
          wide
          onClose={closeEditor}
          footer={
            <>
              {serverDraft.id ? <button className="danger-text dialog-danger" onClick={() => openConfirm({
                title: '删除服务器',
                message: '确认删除当前服务器吗？',
                onConfirm: () => removeServer()
              })}>删除</button> : <span />}
              <div className="dialog-actions">
                {serverDraft.id ? <button className="ghost" onClick={() => {
                  closeEditor();
                  openTerminal(selectedServer || serverDraft);
                }}>终端</button> : null}
                <button className="ghost" onClick={closeEditor}>取消</button>
                <button className={'primary ' + (busy.saveServer ? 'is-loading' : '')} onClick={saveServer} disabled={busy.saveServer}>
                  {busy.saveServer ? '保存中...' : '保存'}
                </button>
              </div>
            </>
          }
        >
          <div className="field-grid">
            <Field label="名称">
              <input value={serverDraft.name} onChange={(event) => setServerDraft((current) => ({ ...current, name: event.target.value }))} />
            </Field>
            <Field label="IP">
              <input value={serverDraft.host} onChange={(event) => setServerDraft((current) => ({ ...current, host: event.target.value }))} />
            </Field>
            <Field label="端口">
              <input value={serverDraft.port} onChange={(event) => setServerDraft((current) => ({ ...current, port: event.target.value }))} />
            </Field>
            <Field label="用户名">
              <input value={serverDraft.username} onChange={(event) => setServerDraft((current) => ({ ...current, username: event.target.value }))} />
            </Field>
            <Field label="密码">
              <div className="password-field">
                <input
                  type={showServerPassword ? 'text' : 'password'}
                  value={serverDraft.password}
                  placeholder={serverDraft.id ? '留空则保持不变' : ''}
                  onChange={(event) => setServerDraft((current) => ({ ...current, password: event.target.value }))}
                />
                <button
                  className="icon-button password-toggle"
                  type="button"
                  onClick={() => setShowServerPassword((value) => !value)}
                  aria-label={showServerPassword ? '隐藏密码' : '显示密码'}
                >
                  {showServerPassword ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              </div>
            </Field>
            <Field label="分组">
              <select value={serverDraft.groupId} onChange={(event) => setServerDraft((current) => ({ ...current, groupId: event.target.value }))}>
                {state.groups.map((group) => (
                  <option key={group.id} value={group.id}>{group.name}</option>
                ))}
              </select>
            </Field>
            <Field label="代理">
              <select value={serverDraft.proxyId} onChange={(event) => setServerDraft((current) => ({ ...current, proxyId: event.target.value }))}>
                <option value="">直连</option>
                {state.proxies.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            </Field>
            <Field className="field-span" label="备注">
              <textarea rows={5} value={serverDraft.note} onChange={(event) => setServerDraft((current) => ({ ...current, note: event.target.value }))} />
            </Field>
          </div>
        </Dialog>
      ) : null}

      {editorDialog.open && editorDialog.type === 'command' ? (
        <Dialog
          title={commandDraft.id ? '编辑命令' : '新增命令'}
          onClose={closeEditor}
          footer={
            <>
              {commandDraft.id ? <button className="danger-text dialog-danger" onClick={() => openConfirm({
                title: '删除命令',
                message: '确认删除当前命令吗？',
                onConfirm: () => removeCommand()
              })}>删除</button> : <span />}
              <div className="dialog-actions">
                <button className="ghost" onClick={closeEditor}>取消</button>
                <button className={'primary ' + (busy.saveCommand ? 'is-loading' : '')} onClick={saveCommand} disabled={busy.saveCommand}>
                  {busy.saveCommand ? '保存中...' : '保存'}
                </button>
              </div>
            </>
          }
        >
          <div className="field-grid single">
            <Field label="命令名称">
              <input value={commandDraft.name} onChange={(event) => setCommandDraft((current) => ({ ...current, name: event.target.value }))} />
            </Field>
            <Field className="field-span" label="执行内容">
              <textarea
                rows={12}
                value={commandDraft.command}
                onChange={(event) => {
                  const value = event.target.value;
                  setCommandDraft((current) => ({ ...current, command: value }));
                  setCommandText(value);
                }}
              />
            </Field>
          </div>
        </Dialog>
      ) : null}

      {editorDialog.open && editorDialog.type === 'proxy' ? (
        <Dialog
          title={proxyDraft.id ? '编辑代理' : '新增代理'}
          onClose={closeEditor}
          footer={
            <>
              {proxyDraft.id ? <button className="danger-text dialog-danger" onClick={() => openConfirm({
                title: '删除代理',
                message: '确认删除当前代理吗？',
                onConfirm: () => removeProxy()
              })}>删除</button> : <span />}
              <div className="dialog-actions">
                <button className="ghost" onClick={closeEditor}>取消</button>
                <button className={'primary ' + (busy.saveProxy ? 'is-loading' : '')} onClick={saveProxy} disabled={busy.saveProxy}>
                  {busy.saveProxy ? '保存中...' : '保存'}
                </button>
              </div>
            </>
          }
        >
          <div className="field-grid">
            <Field label="代理名称">
              <input value={proxyDraft.name} onChange={(event) => setProxyDraft((current) => ({ ...current, name: event.target.value }))} />
            </Field>
            <Field label="类型">
              <select value={proxyDraft.type} onChange={(event) => setProxyDraft((current) => ({ ...current, type: event.target.value }))}>
                <option value="socks5">SOCKS5</option>
                <option value="http">HTTP</option>
              </select>
            </Field>
            <Field label="地址">
              <input value={proxyDraft.host} onChange={(event) => setProxyDraft((current) => ({ ...current, host: event.target.value }))} />
            </Field>
            <Field label="端口">
              <input value={proxyDraft.port} onChange={(event) => setProxyDraft((current) => ({ ...current, port: event.target.value }))} />
            </Field>
            <Field label="用户名">
              <input value={proxyDraft.username} onChange={(event) => setProxyDraft((current) => ({ ...current, username: event.target.value }))} />
            </Field>
            <Field label="密码">
              <input
                type="password"
                value={proxyDraft.password}
                placeholder={proxyDraft.id ? '留空则保持不变' : ''}
                onChange={(event) => setProxyDraft((current) => ({ ...current, password: event.target.value }))}
              />
            </Field>
          </div>
        </Dialog>
      ) : null}

      {settingsDialogOpen ? (
        <Dialog
          title="账户设置"
          onClose={() => {
            setSettingsDialogOpen(false);
            setAccountError('');
          }}
          footer={
            <>
              <button className="danger-text dialog-danger" onClick={logout}>退出登录</button>
              <div className="dialog-actions">
                <button className="ghost" onClick={() => {
                  setSettingsDialogOpen(false);
                  setAccountError('');
                }}>取消</button>
              <button className={'primary ' + (busy.account ? 'is-loading' : '')} onClick={saveAccount} disabled={busy.account}>
                  {busy.account ? '保存中...' : '保存'}
                </button>
              </div>
            </>
          }
        >
          <div className="field-grid single">
            <Field label="用户名">
              <input
                value={accountForm.username}
                onChange={(event) => setAccountForm((current) => ({ ...current, username: event.target.value }))}
              />
            </Field>
            <Field label="当前密码">
              <input
                type="password"
                value={accountForm.currentPassword}
                onChange={(event) => setAccountForm((current) => ({ ...current, currentPassword: event.target.value }))}
              />
            </Field>
            <Field label="新密码">
              <input
                type="password"
                value={accountForm.newPassword}
                placeholder="留空则不修改"
                onChange={(event) => setAccountForm((current) => ({ ...current, newPassword: event.target.value }))}
              />
            </Field>
            <Field label="确认新密码">
              <input
                type="password"
                value={accountForm.confirmPassword}
                placeholder="留空则不修改"
                onChange={(event) => setAccountForm((current) => ({ ...current, confirmPassword: event.target.value }))}
              />
            </Field>
          </div>
          {accountError ? <div className="auth-error inline-error">{accountError}</div> : null}
        </Dialog>
      ) : null}

      {serverPickerOpen ? (
        <Dialog
          title={serverPickerMode === 'proxy' ? '选择服务器并应用代理' : '选择服务器'}
          xwide
          className="server-picker-dialog"
          onClose={() => setServerPickerOpen(false)}
          footer={
            <>
              <div className="picker-footer-meta">
                <strong>{pickerSelectedIds.length}</strong>
                <span>已选服务器</span>
              </div>
              <div className="dialog-actions">
                <button className="ghost" onClick={selectAllServers}>全选全部</button>
                <button className="ghost" onClick={() => setPickerSelectedIds([])}>清空全部</button>
                <button
                  className={'primary ' + (busy.applyProxyServers && serverPickerMode === 'proxy' ? 'is-loading' : '')}
                  onClick={confirmServerPicker}
                  disabled={serverPickerMode === 'proxy' ? busy.applyProxyServers : false}
                >
                  {serverPickerMode === 'proxy'
                    ? (busy.applyProxyServers ? '应用中...' : '应用到代理')
                    : '完成'}
                </button>
              </div>
            </>
          }
        >
          <div className="server-picker-layout">
            <aside className="server-picker-groups">
              <div className="picker-side-head">
                <strong>分组</strong>
                <span>{state.groups.length + 1}</span>
              </div>
                <button className={'picker-group-row ' + (pickerGroupId === 'all' ? 'active' : '')} onClick={() => setPickerGroupId('all')}>
                <div>
                  <strong>全部服务器</strong>
                  <span>{state.servers.length} 台</span>
                </div>
              </button>
              {state.groups.map((group) => {
                const groupServers = state.servers.filter((item) => item.groupId === group.id);
                const groupSelected = groupServers.length > 0 && groupServers.every((item) => pickerSelectedIds.includes(item.id));
                return (
                  <div key={group.id} className={'picker-group-row ' + (pickerGroupId === group.id ? 'active' : '')}>
                    <button className="picker-group-main" onClick={() => setPickerGroupId(group.id)}>
                      <div>
                        <strong>{group.name}</strong>
                        <span>{groupServers.length} 台</span>
                      </div>
                    </button>
                    <button className={'ghost mini-toggle ' + (groupSelected ? 'active' : '')} onClick={() => toggleGroupChecked(group.id)}>
                      {groupSelected ? '取消本组' : '选择本组'}
                    </button>
                  </div>
                );
              })}
            </aside>

            <section className="server-picker-list">
              <div className="picker-toolbar">
                <div className="picker-toolbar-copy">
                  <strong>{pickerGroupId === 'all' ? '服务器列表' : (state.groups.find((item) => item.id === pickerGroupId)?.name || '服务器列表')}</strong>
                  <span>{pickerFilteredServers.length} 台</span>
                </div>
                <div className="search-shell picker-search">
                  <SearchIcon />
                  <input value={pickerSearch} onChange={(event) => setPickerSearch(event.target.value)} placeholder="搜索服务器名或 IP" />
                </div>
                <div className="dialog-actions">
                  <button className="ghost" onClick={selectCurrentPickerGroup}>全选当前</button>
                  <button className="ghost" onClick={clearCurrentPickerGroup}>清空当前</button>
                </div>
              </div>

              <div className="picker-table-head">
                <span />
                <span>名称</span>
                <span>IP:端口</span>
                <span>分组</span>
              </div>

              <div className="picker-table-body">
                {pickerFilteredServers.length ? (
                  pickerFilteredServers.map((item) => (
                    <label key={item.id} className={'picker-server-row ' + (pickerSelectedIds.includes(item.id) ? 'selected' : '')}>
                      <input type="checkbox" checked={pickerSelectedIds.includes(item.id)} onChange={() => togglePickerServerChecked(item.id)} />
                      <div>
                        <strong>{item.name}</strong>
                      </div>
                      <span>{item.host}:{item.port}</span>
                      <em>{state.groups.find((group) => group.id === item.groupId)?.name || '默认分组'}</em>
                    </label>
                  ))
                ) : (
                  <div className="empty-state picker-empty">当前条件下没有服务器</div>
                )}
              </div>
            </section>
          </div>
        </Dialog>
      ) : null}

      {groupDialog.open ? (
        <Dialog
          title={groupDialog.value.id ? '编辑分组' : '新增分组'}
          onClose={() => setGroupDialog({ open: false, value: EMPTY_GROUP })}
          footer={
            <>
              <button className="ghost" onClick={() => setGroupDialog({ open: false, value: EMPTY_GROUP })}>取消</button>
              <button className={'primary ' + (busy.saveGroup ? 'is-loading' : '')} onClick={saveGroup} disabled={busy.saveGroup}>
                {busy.saveGroup ? '保存中...' : '保存分组'}
              </button>
            </>
          }
        >
          <div className="field-grid single">
            <Field label="分组名称">
              <input
                value={groupDialog.value.name}
                onChange={(event) => setGroupDialog((current) => ({ ...current, value: { ...current.value, name: event.target.value } }))}
              />
            </Field>
            <Field className="field-span" label="备注">
              <textarea
                rows={4}
                value={groupDialog.value.note}
                onChange={(event) => setGroupDialog((current) => ({ ...current, value: { ...current.value, note: event.target.value } }))}
              />
            </Field>
          </div>
        </Dialog>
      ) : null}

      {confirmDialog.open ? (
        <Dialog
          title={confirmDialog.title}
          onClose={closeConfirm}
          footer={
            <>
              <span />
              <div className="dialog-actions">
                <button className="ghost" onClick={closeConfirm}>取消</button>
                <button
                  className="primary"
                  onClick={async () => {
                    const action = confirmDialog.onConfirm;
                    closeConfirm();
                    if (action) {
                      await action();
                    }
                  }}
                >
                  确认
                </button>
              </div>
            </>
          }
        >
          <div className="confirm-copy">{confirmDialog.message}</div>
        </Dialog>
      ) : null}

      {importDialog.open ? (
        <Dialog
          title="批量导入服务器"
          wide
          onClose={() => setImportDialog({ open: false, text: '', preview: null, confirmOverwrite: false, loading: false })}
          footer={
            <>
              <button className={'ghost ' + (busy.previewImport ? 'is-loading' : '')} onClick={previewImport} disabled={busy.previewImport}>
                {busy.previewImport ? '预览中...' : '预览'}
              </button>
              {importDialog.preview?.duplicateCount ? (
                <button className="ghost" onClick={() => setImportDialog((current) => ({ ...current, confirmOverwrite: true }))}>
                  发现重复 {importDialog.preview.duplicateCount} 台
                </button>
              ) : null}
              <button className={'primary ' + (busy.applyImport ? 'is-loading' : '')} onClick={() => applyImport(false)} disabled={busy.applyImport}>
                {busy.applyImport ? '导入中...' : '直接导入'}
              </button>
              {importDialog.confirmOverwrite ? (
                <button className={'primary ' + (busy.applyImportOverwrite ? 'is-loading' : '')} onClick={() => applyImport(true)} disabled={busy.applyImportOverwrite}>
                  {busy.applyImportOverwrite ? '覆盖中...' : '覆盖并继续'}
                </button>
              ) : null}
            </>
          }
        >
          <div className="import-layout">
            <label className="field field-span">
              <span>名称 IP 端口 用户名 密码 分组</span>
              <textarea
                rows={12}
                value={importDialog.text}
                onChange={(event) => setImportDialog((current) => ({ ...current, text: event.target.value }))}
                placeholder={'hk-node 1.2.3.4 22 root 123456 香港\nsg-prod 8.8.8.8 22 root passw0rd 新加坡'}
              />
            </label>
            <div className="import-preview surface">
              <div className="workspace-head">
                <div>
                  <strong>导入预览</strong>
                  <span>{importDialog.loading ? '识别中...' : importDialog.preview ? (importDialog.preview.total + ' 条') : '未预览'}</span>
                </div>
              </div>
              <div className="preview-table">
                {(importDialog.preview?.items || []).map((item) => (
                  <div key={item.id} className={'preview-row ' + (item.duplicate ? 'duplicate' : '')}>
                    <strong>{item.name}</strong>
                    <span>{item.host}:{item.port}</span>
                    <em>{item.username}</em>
                      <b>{item.groupName || '默认分组'}</b>
                      <small>{item.duplicate ? ('重复: ' + item.duplicateName) : '新服务器'}</small>
                  </div>
                ))}
                {!importDialog.preview?.items?.length ? <div className="empty-state">导入前会先告诉你哪些条目需要覆盖。</div> : null}
              </div>
            </div>
          </div>
        </Dialog>
      ) : null}

      {runCommandConfirmOpen ? (
        <Dialog
          title="临时交互关键字"
          onClose={() => setRunCommandConfirmOpen(false)}
          footer={
            <>
              <button className="ghost" onClick={() => setRunCommandConfirmOpen(false)}>取消</button>
              <button className="ghost" onClick={openTemporaryInteractiveKeywordsDialog}>是，去设置</button>
              <button
                className={'primary ' + (busy.runCommand ? 'is-loading' : '')}
                onClick={() => void runCommandWithGlobalKeywords()}
                disabled={busy.runCommand}
              >
                {busy.runCommand ? '执行中...' : '否，立即执行'}
              </button>
            </>
          }
        >
          <div className="confirm-copy">
            本次执行是否单独设置临时交互关键字？如果不设置，将继续使用当前全局交互规则。
          </div>
        </Dialog>
      ) : null}

      {temporaryKeywordsDialogOpen ? (
        <Dialog
          title="本次临时关键字"
          onClose={() => setTemporaryKeywordsDialogOpen(false)}
          footer={
            <>
              <button className="ghost" onClick={() => setTemporaryKeywordsDialogOpen(false)}>取消</button>
              <button
                className={'primary ' + (busy.runCommand ? 'is-loading' : '')}
                onClick={() => void runCommandWithTemporaryKeywords()}
                disabled={busy.runCommand}
              >
                {busy.runCommand ? '执行中...' : '立即执行'}
              </button>
            </>
          }
        >
          <div className="field-grid single">
            <Field label="临时关键字">
              <textarea
                rows={8}
                value={temporaryInteractiveKeywordsText}
                onChange={(event) => setTemporaryInteractiveKeywordsText(event.target.value)}
                placeholder={'每行一个，默认留空\n留空表示这次不使用自定义关键字'}
              />
            </Field>
            <div className="confirm-copy">设置后仅对本次执行生效，不覆盖全局交互规则。</div>
          </div>
        </Dialog>
      ) : null}

      {batchInputDialog.open ? (
        <Dialog
          title={batchInputDialog.mode === 'broadcast' ? '统一输入' : batchInputDialog.mode === 'wait' ? '等待执行结果' : '检测到交互输入'}
          onClose={closeBatchInputDialog}
          footer={
            batchInputDialog.mode === 'broadcast'
              ? (
                <>
                  <button className="ghost" onClick={closeBatchInputDialog}>取消</button>
                  <button
                    className={'primary ' + (busy.submitBatchInput ? 'is-loading' : '')}
                    onClick={submitBatchInput}
                    disabled={busy.submitBatchInput}
                  >
                    {busy.submitBatchInput ? '发送中...' : ('发送到 ' + batchInputDialog.awaitingServerIds.length + ' 台服务器')}
                  </button>
                </>
              )
              : batchInputDialog.mode === 'wait'
              ? (
                <>
                  <button className="ghost" onClick={closeBatchInputDialog}>取消</button>
                </>
              )
              : (
                <>
                  <button className="ghost" onClick={closeBatchInputDialog}>取消</button>
                  <button className="ghost" onClick={() => chooseBatchInputIndividually()}>逐台处理</button>
                  <button className="primary" onClick={openBroadcastInputDialog}>统一输入</button>
                </>
              )
          }
        >
          {batchInputDialog.mode === 'broadcast' ? (
            <form
              className="field-grid single"
              onSubmit={(event) => {
                event.preventDefault();
                void submitBatchInput();
              }}
            >
              {awaitingInputPreview ? (
                <Field label="当前等待输入内容">
                  <AutoScrollPre text={awaitingInputPreview} className="batch-input-preview" />
                </Field>
              ) : null}
              <Field label="输入内容">
                <textarea
                  rows={5}
                  value={batchInputDialog.value}
                  onChange={(event) => setBatchInputDialog((current) => ({ ...current, value: event.target.value }))}
                  placeholder="留空表示直接发送一个回车"
                />
              </Field>
              <div className="confirm-copy">会把这段输入同时发给所有仍在等待输入的服务器。</div>
            </form>
          ) : batchInputDialog.mode === 'wait' ? (
            <div className="field-grid single">
              <div className="confirm-copy batch-input-progress-copy">
                当前已出结果 {resolvedCommandResultCount} / {commandProgress.total} 台，剩余 {pendingCommandResultCount} 台还在执行中。全部服务器都有结果后，才可以进入统一输入或逐台处理。失败也会算作已有结果。
              </div>
            </div>
          ) : (
            <div className="field-grid single">
              <div className="confirm-copy">
                检测到 {batchInputDialog.awaitingServerIds.length} 台服务器正在等待交互输入。当前已出结果 {resolvedCommandResultCount} / {commandProgress.total} 台。你可以统一输入一份内容广播给它们，或者逐台进入真实会话分别处理。
              </div>
              {visibleBatchInputAwaitingResults.length ? (
                <div className="batch-input-server-list">
                  {visibleBatchInputAwaitingResults.map((item) => (
                    <button
                      key={item.serverId}
                      className="ghost batch-input-server-button"
                      type="button"
                      onClick={() => chooseBatchInputIndividually(item.serverId)}
                    >
                      {item.name}
                      <span>{item.host}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              {hiddenBatchInputAwaitingResultsCount ? (
                <div className="confirm-copy batch-input-server-summary">
                  当前仅展示前 {visibleBatchInputAwaitingResults.length} 台，剩余 {hiddenBatchInputAwaitingResultsCount} 台不再展开，避免数量过多撑满弹窗。
                </div>
              ) : null}
            </div>
          )}
        </Dialog>
      ) : null}

      {interactiveKeywordsDialogOpen ? (
        <Dialog
          title="交互规则"
          onClose={() => setInteractiveKeywordsDialogOpen(false)}
          footer={
            <>
              <button className="ghost" onClick={() => setInteractiveKeywordsDialogOpen(false)}>取消</button>
              <button className="primary" onClick={saveInteractiveKeywords}>保存</button>
            </>
          }
        >
          <div className="field-grid single">
            <Field label="关键字列表">
              <textarea
                rows={8}
                value={interactiveKeywordsText}
                onChange={(event) => setInteractiveKeywordsText(event.target.value)}
                placeholder={'请\n请输入\n请选择\n按回车'}
              />
            </Field>
            <div className="confirm-copy">每行一个关键字。命中这些关键字时，结果会被视为交互式等待输入。</div>
          </div>
        </Dialog>
      ) : null}

      {resultTerminalSession ? (
        <TerminalWorkspace
          key={resultTerminalSession.id}
          session={resultTerminalSession}
          theme={theme}
          commands={state.commands}
          mode={resultTerminalSession.mode}
          content={resultTerminalSession.content}
          isFullscreen
          onEnterFullscreen={() => undefined}
          onExitFullscreen={() => setResultTerminalServerId('')}
        />
      ) : null}

      <div className="toast-stack">
        {toasts.map((item) => (
          <div key={item.id} className="toast">{item.message}</div>
        ))}
      </div>
    </div>
  );
}

function ServerOverview({ selectedServer, state, selectedServerIds, openTerminal, onCreateServer, onImport, onCreateGroup }) {
  return (
    <div className="overview-shell">
      <div className="surface overview-highlight">
        <span className="label-chip">Workspace</span>
        <strong>{selectedServer ? selectedServer.name : 'NuroSSH'}</strong>
        <p>{selectedServer ? (selectedServer.host + ':' + selectedServer.port + ' 路 ' + selectedServer.username) : '服务器管理与终端工作台'}</p>
        <div className="hero-actions">
          {selectedServer ? <button className="primary" onClick={() => openTerminal(selectedServer)}>打开终端</button> : null}
          <button className="ghost" onClick={onCreateServer}>新增服务器</button>
          <button className="ghost" onClick={onImport}>批量导入</button>
          <button className="ghost" onClick={onCreateGroup}>新建分组</button>
        </div>
      </div>

      <div className="overview-grid">
        <div className="surface overview-card">
          <strong>{state.groups.length}</strong>
          <span>分组</span>
        </div>
        <div className="surface overview-card">
          <strong>{state.servers.length}</strong>
          <span>个服务器</span>
        </div>
        <div className="surface overview-card">
          <strong>{state.commands.length}</strong>
          <span>命令</span>
        </div>
        <div className="surface overview-card">
          <strong>{state.proxies.length}</strong>
          <span>代理</span>
        </div>
      </div>
    </div>
  );
}

function AutoScrollPre({ text, className = '' }) {
  const preRef = useRef(null);

  useEffect(() => {
    const element = preRef.current;
    if (!element) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
      element.scrollLeft = element.scrollWidth;
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [text]);

  return <pre ref={preRef} className={className}>{text}</pre>;
}

function canWriteToSocket(socket) {
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

function SessionTabs({ sessions, activeId, onSelect, onClose }) {
  const stripRef = useRef(null);
  const [scrollable, setScrollable] = useState({ left: false, right: false });

  useEffect(() => {
    const updateScrollable = () => {
      const element = stripRef.current;
      if (!element) {
        return;
      }
      setScrollable({
        left: element.scrollLeft > 4,
        right: element.scrollLeft + element.clientWidth < element.scrollWidth - 4
      });
    };

    const handleWheel = (event) => {
      const element = stripRef.current;
      if (!element) {
        return;
      }
      if (element.scrollWidth <= element.clientWidth) {
        return;
      }
      const inStrip = element.contains(event.target);
      if (!inStrip) {
        return;
      }
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      element.scrollLeft += delta;
      updateScrollable();
      event.preventDefault();
    };

    const handleScroll = () => updateScrollable();
    const resizeObserver = new ResizeObserver(() => updateScrollable());
    const element = stripRef.current;
    if (element) {
      element.addEventListener('scroll', handleScroll, { passive: true });
      resizeObserver.observe(element);
      updateScrollable();
    }

    window.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    return () => {
      if (element) {
        element.removeEventListener('scroll', handleScroll);
      }
      resizeObserver.disconnect();
      window.removeEventListener('wheel', handleWheel, { capture: true });
    };
  }, []);

  useEffect(() => {
    const element = stripRef.current;
    if (!element) {
      return;
    }
    const activeTab = element.querySelector('.session-tab.active');
    if (!activeTab) {
      return;
    }
    window.requestAnimationFrame(() => {
      const safeGapLeft = 4;
      const safeGapRight = 9;
      const tabLeft = activeTab.offsetLeft;
      const tabRight = tabLeft + activeTab.offsetWidth;
      const viewLeft = element.scrollLeft;
      const viewRight = viewLeft + element.clientWidth;
      if (tabLeft < viewLeft + safeGapLeft) {
        element.scrollTo({
          left: Math.max(0, tabLeft - safeGapLeft),
          behavior: 'smooth'
        });
        return;
      }
      if (tabRight > viewRight - safeGapRight) {
        element.scrollTo({
          left: Math.max(0, tabRight - element.clientWidth + safeGapRight),
          behavior: 'smooth'
        });
      }
    });
  }, [activeId, sessions.length]);

  function scrollTabs(direction) {
    const element = stripRef.current;
    if (!element) {
      return;
    }
    element.scrollBy({
      left: direction * Math.max(180, Math.round(element.clientWidth * 0.45)),
      behavior: 'smooth'
    });
  }

  return (
    <div className="session-strip-shell">
      <button
        className={'icon-button session-scroll-button ' + (scrollable.left ? '' : 'is-hidden')}
        onClick={() => scrollTabs(-1)}
        type="button"
        disabled={!scrollable.left}
        aria-label="向左滚动会话"
      >
        <ArrowLeftIcon />
      </button>
      <div
        ref={stripRef}
        className="session-strip"
        onWheelCapture={(event) => {
          const element = stripRef.current;
          if (!element || element.scrollWidth <= element.clientWidth) {
            return;
          }
          const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
          element.scrollLeft += delta;
          event.preventDefault();
        }}
      >
        {sessions.length ? (
          sessions.map((session) => (
            <button
              key={session.id}
              className={'session-tab ' + (activeId === session.id ? 'active' : '')}
              onClick={() => onSelect(session.id)}
            >
              <span>{session.title}</span>
              <span
                className="session-close"
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(session.id);
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    event.stopPropagation();
                    onClose(session.id);
                  }
                }}
              >
                <CloseIcon />
              </span>
            </button>
          ))
        ) : (
          <div className="session-empty">暂无会话</div>
        )}
      </div>
      <button
        className={'icon-button session-scroll-button ' + (scrollable.right ? '' : 'is-hidden')}
        onClick={() => scrollTabs(1)}
        type="button"
        disabled={!scrollable.right}
        aria-label="向右滚动会话"
      >
        <ArrowRightIcon />
      </button>
    </div>
  );
}

function TerminalSessionDeck({
  sessions,
  activeId,
  theme,
  commands,
  fullscreenId,
  isVisible,
  onEnterFullscreen,
  onExitFullscreen
}) {
  return (
    <div className="terminal-deck">
      {sessions.map((session) => (
        <TerminalWorkspace
          key={session.id}
          session={session}
          theme={theme}
          commands={commands}
          isVisible={isVisible && activeId === session.id}
          isFullscreen={fullscreenId === session.id}
          onEnterFullscreen={() => onEnterFullscreen(session.id)}
          onExitFullscreen={onExitFullscreen}
        />
      ))}
    </div>
  );
}

function TerminalWorkspace({
  session,
  theme,
  commands = [],
  mode = 'ssh',
  content = '',
  isVisible = true,
  isFullscreen,
  onEnterFullscreen,
  onExitFullscreen
}) {
  const rootRef = useRef(null);
  const rootShellRef = useRef(null);
  const suggestionRef = useRef(null);
  const terminalRef = useRef(null);
  const fitRef = useRef(null);
  const socketRef = useRef(null);
  const resizeRef = useRef(() => {});
  const canReconnectRef = useRef(false);
  const visibleRef = useRef(isVisible);
  const [status, setStatus] = useState('连接中...');
  const [ready, setReady] = useState(false);
  const [canReconnect, setCanReconnect] = useState(false);
  const [connectNonce, setConnectNonce] = useState(0);
  const currentInputRef = useRef('');
  const [currentInput, setCurrentInput] = useState('');
  const [manualInput, setManualInput] = useState('');
  const [manualInputBusy, setManualInputBusy] = useState(false);
  const [suggestionTop, setSuggestionTop] = useState(12);
  const [suggestionLeft, setSuggestionLeft] = useState(72);
  const isLiveSession = mode !== 'result';

  const terminalTheme = useMemo(
    () => (theme === 'hbx-light'
      ? {
          background: '#f3f8ef',
          foreground: '#2f4b3d',
          cursor: '#2f4b3d',
          cursorAccent: '#f3f8ef',
          selectionBackground: 'rgba(95, 143, 118, 0.34)',
          selectionInactiveBackground: 'rgba(95, 143, 118, 0.22)',
          selectionForeground: '#1f3128',
          black: '#5f7888',
          red: '#d94653',
          green: '#2f7d5d',
          yellow: '#b7791f',
          blue: '#2563eb',
          magenta: '#7c3aed',
          cyan: '#0f766e',
          white: '#40554d',
          brightBlack: '#7d8f99',
          brightWhite: '#23342d'
        }
      : {
          background: '#08111f',
          foreground: '#dbe4f0',
          cursor: '#f8fafc',
          cursorAccent: '#08111f',
          selectionBackground: 'rgba(125, 211, 252, 0.28)',
          selectionInactiveBackground: 'rgba(125, 211, 252, 0.16)',
          selectionForeground: '#f8fafc',
          black: '#0f172a',
          red: '#ef4444',
          green: '#22c55e',
          yellow: '#f59e0b',
          blue: '#60a5fa',
          magenta: '#a78bfa',
          cyan: '#22d3ee',
          white: '#e2e8f0',
          brightBlack: '#475569',
          brightWhite: '#ffffff'
        }),
    [theme]
  );

  const commandSuggestion = useMemo(() => {
    if (!isLiveSession) {
      return null;
    }
    const prefix = String(currentInput || '').trim().toLowerCase();
    if (!prefix) {
      return null;
    }
    return commands.find((item) => {
      const name = String(item?.name || '').toLowerCase();
      const command = String(item?.command || '').toLowerCase();
      return name.startsWith(prefix) || command.startsWith(prefix);
    }) || null;
  }, [commands, currentInput, isLiveSession]);

  function syncCurrentInput(value) {
    currentInputRef.current = value;
    setCurrentInput(value);
  }

  function updateSuggestionPosition(nextTerminal = terminalRef.current) {
    const terminal = nextTerminal;
    const shell = rootShellRef.current;
    if (!terminal || !shell || !terminal.rows) {
      return;
    }
    const lineHeight = shell.clientHeight / terminal.rows;
    const cellWidth = terminal.cols ? shell.clientWidth / terminal.cols : 8;
    const cursorRow = terminal.buffer.active.cursorY || 0;
    const cursorCol = terminal.buffer.active.cursorX || 0;
    const suggestionHeight = suggestionRef.current?.offsetHeight || 34;
    const lineCenterTop = shell.offsetTop + (cursorRow * lineHeight) + (lineHeight / 2);
    const nextTop = lineCenterTop - (suggestionHeight / 2) - 2;
    const nextLeft = shell.offsetLeft + ((cursorCol + 1) * cellWidth) + 10;
    const minTop = shell.offsetTop + 4;
    const maxTop = shell.offsetTop + shell.clientHeight - suggestionHeight - 4;
    setSuggestionTop(Math.round(Math.min(Math.max(nextTop, minTop), Math.max(minTop, maxTop))));
    setSuggestionLeft(Math.max(72, Math.round(nextLeft)));
  }

  function applyInputChunk(data) {
    let next = currentInputRef.current;
    const parts = String(data || '').split(/(\r|\n)/);
    for (const part of parts) {
      if (!part) {
        continue;
      }
      if (part === '\r' || part === '\n') {
        next = '';
        continue;
      }
      if (part.startsWith('\u001b')) {
        continue;
      }
      for (const char of part) {
        if (char === '\u007f') {
          next = next.slice(0, -1);
          continue;
        }
        if (char === '\u0015' || char === '\u0003') {
          next = '';
          continue;
        }
        if (char >= ' ') {
          next += char;
        }
      }
    }
    syncCurrentInput(next);
  }

  function executeSuggestedCommand() {
    if (!commandSuggestion || !canWriteToSocket(socketRef.current)) {
      return;
    }
    const clearCurrentInput = '\u007f'.repeat(currentInputRef.current.length);
      socketRef.current.send(JSON.stringify({
        type: 'input',
        data: clearCurrentInput + commandSuggestion.command + '\r'
      }));
    syncCurrentInput('');
    terminalRef.current?.focus();
  }

  async function sendManualCommand(value, options = {}) {
    const { appendEnter = true, preferSocket = false } = options;
    const socket = socketRef.current;
    const payload = appendEnter ? (value + '\r') : value;

    if ((preferSocket || mode !== 'command-job' || !session.jobId) && canWriteToSocket(socket)) {
      socket.send(JSON.stringify({ type: 'input', data: payload }));
      if (appendEnter) {
        setManualInput('');
      }
      terminalRef.current?.focus();
      return;
    }

    if (mode !== 'command-job' || !session.jobId || !session.serverId) {
      return;
    }

    try {
      setManualInputBusy(true);
      await api('/api/commands/jobs/' + session.jobId + '/input', {
        method: 'POST',
        body: JSON.stringify({
          serverIds: [session.serverId],
          data: appendEnter ? value : payload,
          raw: !appendEnter
        })
      });
      if (appendEnter) {
        setManualInput('');
      }
      terminalRef.current?.focus();
    } catch (error) {
      terminalRef.current?.writeln('\r\n[系统] ' + error.message);
    } finally {
      setManualInputBusy(false);
    }
  }

  useEffect(() => {
    canReconnectRef.current = canReconnect;
  }, [canReconnect]);

  useEffect(() => {
    visibleRef.current = isVisible;
  }, [isVisible]);

  useEffect(() => {
    const terminal = new Terminal({
      fontFamily: '"Cascadia Mono","JetBrains Mono","SFMono-Regular","Consolas",monospace',
      fontSize: 12,
      lineHeight: 1.18,
      scrollback: 20000,
      cursorBlink: true,
      disableStdin: !isLiveSession,
      macOptionClickForcesSelection: true,
      rightClickSelectsWord: true,
      theme: terminalTheme
    });
    const fitAddon = new FitAddon();

    terminal.loadAddon(fitAddon);
    terminal.open(rootRef.current);
    terminal.attachCustomKeyEventHandler((event) => {
      const isPrimary = event.ctrlKey || event.metaKey;
      if (isPrimary && !event.shiftKey && (event.key === 'a' || event.key === 'A')) {
        event.preventDefault();
        terminal.selectAll();
        return false;
      }
      if (isPrimary && (event.key === 'c' || event.key === 'C') && terminal.hasSelection()) {
        event.preventDefault();
        const selection = terminal.getSelection();
        if (selection && navigator.clipboard?.writeText) {
          void navigator.clipboard.writeText(selection).catch(() => undefined);
        }
        return false;
      }
      return true;
    });
    terminalRef.current = terminal;
    fitRef.current = fitAddon;
    resizeRef.current = () => {
      if (!fitRef.current || !terminalRef.current) {
        return;
      }
      try {
        fitRef.current.fit();
      } catch (_error) {
        return;
      }
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({
          type: 'resize',
          cols: terminalRef.current.cols,
          rows: terminalRef.current.rows
        }));
      }
      updateSuggestionPosition(terminalRef.current);
    };

    const inputDisposable = terminal.onData((data) => {
      applyInputChunk(data);
      if (socketRef.current?.readyState === WebSocket.OPEN) {
        socketRef.current.send(JSON.stringify({ type: 'input', data }));
        return;
      }
      if (canReconnectRef.current) {
        setCanReconnect(false);
        setStatus('重连中...');
        terminal.writeln('\r\n[系统] 正在重连当前会话...');
        setConnectNonce((current) => current + 1);
      }
    });
    const cursorDisposable = terminal.onCursorMove(() => {
      updateSuggestionPosition(terminal);
    });

    const observer = new ResizeObserver(() => {
      resizeRef.current();
    });
    observer.observe(rootRef.current);

    return () => {
      observer.disconnect();
      inputDisposable.dispose();
      cursorDisposable.dispose();
      resizeRef.current = () => {};
      socketRef.current = null;
      fitRef.current = null;
      terminalRef.current = null;
      terminal.dispose();
    };
  }, []);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = terminalTheme;
    }
  }, [terminalTheme]);

  useEffect(() => {
    if (!terminalRef.current || isLiveSession) {
      return;
    }

    const terminal = terminalRef.current;
    terminal.reset();
    terminal.write(String(content || '').replace(/\r?\n/g, '\r\n'));
    setReady(true);
    setCanReconnect(false);
    setStatus('执行结果');
  }, [content, isLiveSession]);

  useEffect(() => {
    if (!isLiveSession) {
      return;
    }

    if (!terminalRef.current) {
      return;
    }
    let cleanedUp = false;
    let disconnectHandled = false;
    const terminal = terminalRef.current;
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const buildSocketPath = () => {
      if (mode === 'command-job') {
        return '/ws/command-job?jobId=' + encodeURIComponent(session.jobId || '') + '&serverId=' + encodeURIComponent(session.serverId);
      }
      return '/ws/terminal?serverId=' + encodeURIComponent(session.serverId);
    };
    const createSocket = () => new WebSocket(protocol + '//' + window.location.host + buildSocketPath());
    const socket = createSocket();
    socketRef.current = socket;

    setReady(false);
    setCanReconnect(false);
    setStatus(connectNonce ? '重连中...' : '连接中...');
    terminal.writeln('\r\n[系统] ' + (connectNonce ? '正在重连...' : ('正在连接 ' + session.title + ' ...')));

    function handleDisconnect(message) {
      if (disconnectHandled || cleanedUp) {
        return;
      }
      disconnectHandled = true;
      setReady(false);
      setCanReconnect(true);
      setStatus(message);
      terminal.writeln('\r\n[系统] ' + message);
    }

    socket.addEventListener('open', () => {
      if (!cleanedUp) {
        setStatus('握手中...');
      }
    });

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'ready') {
        setStatus('已连接');
        setReady(true);
        setCanReconnect(false);
        if (connectNonce) {
          terminal.writeln('\r\n[系统] 已重新连接。');
        }
        resizeRef.current();
      }
      if (message.type === 'history') {
        terminal.reset();
        terminal.write(String(message.data || ''));
        resizeRef.current();
      }
      if (message.type === 'output') {
        terminal.write(message.data);
      }
      if (message.type === 'state') {
        if (message.awaitingInput) {
          setStatus('等待输入');
        } else if (message.status === 'done') {
          setStatus('已完成');
        } else if (message.status === 'error') {
          setStatus('执行失败');
        }
      }
      if (message.type === 'error') {
        handleDisconnect(message.message || '连接失败，按任意键重连');
      }
      if (message.type === 'closed') {
        if (disconnectHandled || cleanedUp) {
          return;
        }
        disconnectHandled = true;
        setReady(false);
        setCanReconnect(false);
        setStatus(mode === 'command-job' ? '会话已结束' : '连接已关闭');
        terminal.writeln('\r\n[系统] ' + (mode === 'command-job' ? '当前执行会话已结束。' : '连接已关闭，按任意键重连'));
      }
    });

    socket.addEventListener('close', () => {
      if (mode === 'command-job' && !disconnectHandled) {
        disconnectHandled = true;
        setReady(false);
        setCanReconnect(false);
        setStatus('执行会话已结束');
        terminal.writeln('\r\n[系统] 当前执行会话已结束。');
        return;
      }
      handleDisconnect('连接已关闭，按任意键重连');
    });

    socket.addEventListener('error', () => {
      handleDisconnect('连接失败，按任意键重连');
    });

    return () => {
      cleanedUp = true;
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      socket.close();
    };
  }, [connectNonce, isLiveSession, mode, session.jobId, session.serverId, session.title]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!visibleRef.current) {
        return;
      }
      resizeRef.current();
      terminalRef.current?.focus();
    }, 30);
    return () => window.clearTimeout(timer);
  }, [isVisible, isFullscreen, ready]);

  useEffect(() => {
    if (!commandSuggestion) {
      return;
    }
    const timer = window.setTimeout(() => {
      updateSuggestionPosition();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [commandSuggestion, currentInput, isVisible, isFullscreen, ready]);

  return (
    <div className={'terminal-shell ' + (isVisible ? '' : 'terminal-shell-hidden') + ' ' + (isFullscreen ? 'terminal-shell-fullscreen' : '')}>
      {isLiveSession && canReconnect ? <div className="terminal-reconnect-hint">连接失败或关闭后，直接在终端里按任意键即可重连当前会话。</div> : null}
      <div className="terminal-stage">
        {commandSuggestion ? (
          <button
            ref={suggestionRef}
            className="terminal-command-suggestion"
            onClick={executeSuggestedCommand}
            onMouseDown={(event) => event.preventDefault()}
            type="button"
            style={{ top: String(suggestionTop) + 'px', left: String(suggestionLeft) + 'px' }}
          >
            <CommandIcon />
            <strong>{commandSuggestion.name}</strong>
            <span className="terminal-command-tooltip">{commandSuggestion.command}</span>
          </button>
        ) : null}
        <div className="terminal-stage-actions">
          <button
            className="icon-button"
            onClick={isFullscreen ? onExitFullscreen : onEnterFullscreen}
            aria-label={isFullscreen ? '关闭全屏' : '全屏'}
            type="button"
          >
            {isFullscreen ? <CollapseIcon /> : <ExpandIcon />}
          </button>
        </div>
        <div
          ref={rootShellRef}
          className="terminal-root"
          onMouseDown={() => {
            window.setTimeout(() => terminalRef.current?.focus(), 0);
          }}
        >
          <div ref={rootRef} className="terminal-host" />
        </div>
        {mode === 'command-job' ? (
          <div className="terminal-manual-input">
            <input
              value={manualInput}
              onChange={(event) => setManualInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void sendManualCommand(manualInput);
                }
              }}
              placeholder="这里可以直接输入，回车发送到当前会话"
            />
            <button className={'ghost ' + (manualInputBusy ? 'is-loading' : '')} type="button" onClick={() => void sendManualCommand(manualInput)} disabled={manualInputBusy}>发送</button>
            <button className={'ghost ' + (manualInputBusy ? 'is-loading' : '')} type="button" onClick={() => void sendManualCommand('', { appendEnter: true })} disabled={manualInputBusy}>回车</button>
            <button className={'ghost danger-text-button ' + (manualInputBusy ? 'is-loading' : '')} type="button" onClick={() => void sendManualCommand('\u0003', { appendEnter: false })} disabled={manualInputBusy}>Ctrl+C</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Field({ label, children, className = '' }) {
  return (
    <label className={'field ' + className}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function Dialog({ title, onClose, footer, children, wide = false, xwide = false, className = '' }) {
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className={'dialog ' + (wide ? 'wide' : '') + ' ' + (xwide ? 'xwide' : '') + ' ' + className} onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head">
          <strong>{title}</strong>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        <div className="dialog-footer">{footer}</div>
      </div>
    </div>
  );
}

async function api(url, options = {}) {
  const { onUnauthorized, authFree, ...fetchOptions } = options;
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json'
    },
    ...fetchOptions
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !authFree && onUnauthorized) {
      onUnauthorized();
    }
    throw new Error(data.error || '请求失败');
  }
  return data;
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </svg>
  );
}

function ServerIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="4" y="4.5" width="16" height="6" rx="2" />
      <rect x="4" y="13.5" width="16" height="6" rx="2" />
      <path d="M8 8h.01M8 17h.01M12 8h4M12 17h4" />
    </svg>
  );
}

function CommandIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M8 8l-4 4 4 4" />
      <path d="M13 16h7" />
      <path d="M10 6h10v12H10" />
    </svg>
  );
}

function ProxyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M10 8.4L7.4 15M14 8.4l2.6 6.6M9 18h6" />
    </svg>
  );
}

function ChevronIcon({ collapsed }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={collapsed ? 'collapsed' : ''}>
      <path d="M8 10l4 4 4-4" />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 20l4.5-1 9-9a2 2 0 10-3-3l-9 9L4 20z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M5 7h14M9 7V4h6v3M8 10v7M12 10v7M16 10v7M6 7l1 13h10l1-13" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 6.5v11l9-5.5-9-5.5z" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M8 4H4v4M16 4h4v4M4 16v4h4M20 16v4h-4" />
      <path d="M9 4H6a2 2 0 00-2 2v3M15 4h3a2 2 0 012 2v3M4 15v3a2 2 0 002 2h3M20 15v3a2 2 0 01-2 2h-3" />
    </svg>
  );
}

function CollapseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M9 4H6a2 2 0 00-2 2v3M15 4h3a2 2 0 012 2v3M4 15v3a2 2 0 002 2h3M20 15v3a2 2 0 01-2 2h-3" />
      <path d="M8 8l-4-4M16 8l4-4M8 16l-4 4M16 16l4 4" />
    </svg>
  );
}

function ArrowLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M15 6l-6 6 6 6" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M10.7 3.4h2.6l.6 2.3a7.9 7.9 0 012 .8l2-1.2 1.8 1.8-1.2 2a7.9 7.9 0 01.8 2l2.3.6v2.6l-2.3.6a7.9 7.9 0 01-.8 2l1.2 2-1.8 1.8-2-1.2a7.9 7.9 0 01-2 .8l-.6 2.3h-2.6l-.6-2.3a7.9 7.9 0 01-2-.8l-2 1.2-1.8-1.8 1.2-2a7.9 7.9 0 01-.8-2l-2.3-.6v-2.6l2.3-.6a7.9 7.9 0 01.8-2l-1.2-2 1.8-1.8 2 1.2a7.9 7.9 0 012-.8l.6-2.3z" />
      <circle cx="12" cy="12" r="3.2" />
    </svg>
  );
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 3l18 18" />
      <path d="M10.6 10.6A3 3 0 0012 15a3 3 0 002.4-4.8" />
      <path d="M6.7 6.8C4.2 8.5 2.5 12 2.5 12s3.5 6 9.5 6c2 0 3.7-.5 5.2-1.3" />
      <path d="M9.9 4.5A11 11 0 0112 4c6 0 9.5 6 9.5 6a18 18 0 01-2.6 3.5" />
    </svg>
  );
}

function ThemeIcon({ theme }) {
  if (theme === 'hbx-light') {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <circle cx="12" cy="12" r="4.2" />
        <path d="M12 2.8v2.6M12 18.6v2.6M21.2 12h-2.6M5.4 12H2.8M18.6 5.4l-1.8 1.8M7.2 16.8l-1.8 1.8M18.6 18.6l-1.8-1.8M7.2 7.2L5.4 5.4" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M21 12.8A8.8 8.8 0 1111.2 3 7 7 0 0021 12.8z" />
    </svg>
  );
}
