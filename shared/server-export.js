export function formatServerImportField(value) {
  const text = String(value ?? '');
  return !text || /[\s,|"'\\]/.test(text) ? JSON.stringify(text) : text;
}

export function tokenizeServerImportRow(line) {
  const tokens = line.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^\s,|]+/g) || [];
  return tokens.map(token => {
    if (token.startsWith('"') && token.endsWith('"')) {
      try { return JSON.parse(token); } catch { return token.slice(1, -1); }
    }
    return token.replace(/^['"]|['"]$/g, '');
  });
}

export function serverExportText(servers, groupName, mode, passwordFor) {
  return servers.map(server => mode === 'ip' ? server.host : [
    server.name, server.host, server.port || 22, server.username || 'root', passwordFor(server), groupName
  ].map(formatServerImportField).join(' ')).join('\n');
}
