// Both command execution and proxy assignment use the same picker. Whitespace
// separates alternatives (OR), while the selected group remains a constraint.
export function filterPickerServers(servers = [], query = '', groupId = 'all') {
  const keywords = [...new Set(String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean))];
  return servers.filter((server) => {
    if (groupId !== 'all' && server.groupId !== groupId) return false;
    if (!keywords.length) return true;
    // Keep the existing searchable fields; never inspect credentials.
    const fields = [server.name, server.host, server.username, server.note]
      .map((value) => String(value ?? '').toLowerCase());
    return keywords.some((keyword) => fields.some((field) => field.includes(keyword)));
  });
}
