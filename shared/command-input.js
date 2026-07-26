export function parsePerServerInputLines(value, expectedCount) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (lines.length === expectedCount + 1 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

export function hasExactPerServerInputs(inputs, expectedServerIds) {
  if (!Array.isArray(inputs) || !Array.isArray(expectedServerIds) || !inputs.length) {
    return false;
  }
  const expectedServerIdSet = new Set(expectedServerIds);
  const inputServerIdSet = new Set(inputs.map((item) => item?.serverId));
  return (
    expectedServerIdSet.size === expectedServerIds.length &&
    inputs.length === expectedServerIds.length &&
    inputServerIdSet.size === inputs.length &&
    inputs.every(
      (item) =>
        item &&
        typeof item.serverId === 'string' &&
        typeof item.data === 'string' &&
        expectedServerIdSet.has(item.serverId)
    )
  );
}
