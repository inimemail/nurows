function key(username, scope) {
  return `nurossh-location:${encodeURIComponent(username)}:${scope}`;
}

export function readWorkspaceLocation(username, scope) {
  if (!username) return null;
  try {
    return JSON.parse(sessionStorage.getItem(key(username, scope)) || "null");
  } catch {
    return null;
  }
}

export function saveWorkspaceLocation(username, scope, value) {
  if (!username) return;
  try {
    sessionStorage.setItem(key(username, scope), JSON.stringify(value));
  } catch {
    // Navigation still works if browser storage is unavailable.
  }
}
