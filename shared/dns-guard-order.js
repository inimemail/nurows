// Display order is independent of scheduler order. Unknown/deleted IDs are
// discarded and newly created tasks retain their storage order at the end.
export function dnsGuardOrder(records = [], saved = []) {
  const valid = new Set(records.map(item => item.id));
  const order = [...new Set(saved.filter(id => valid.has(id)))];
  const included = new Set(order);
  for (const { id } of records) if (!included.has(id)) { order.push(id); included.add(id); }
  return order;
}

export function moveDnsGuard(order, id, targetId, placement) {
  if (id === targetId || !order.includes(id) || !order.includes(targetId)) return order;
  const next = order.filter(value => value !== id);
  next.splice(next.indexOf(targetId) + (placement === 'after' ? 1 : 0), 0, id);
  return next;
}
