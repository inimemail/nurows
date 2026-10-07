import { useEffect, useMemo, useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';
import { dnsGuardOrder, moveDnsGuard } from '../shared/dns-guard-order.js';

export default function GuardSortableList({ items, records, order, scope, api, onState, toast, onSaving, children }) {
  const [preview, setPreview] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [saving, setSaving] = useState(false);
  const root = useRef(null);
  const drag = useRef(null);
  const frame = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(true);
  const currentOrder = useMemo(() => dnsGuardOrder(records, order || []), [records, order]);
  const visible = useMemo(() => {
    const byId = new Map(items.map(item => [item.id, item]));
    return (preview ? dnsGuardOrder(records, preview) : currentOrder).map(id => byId.get(id)).filter(Boolean);
  }, [items, currentOrder, preview]);

  const cancel = () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const value = drag.current;
    drag.current = null;
    if (value?.handle.hasPointerCapture?.(value.pointerId)) value.handle.releasePointerCapture(value.pointerId);
    if (mounted.current) setDragging(null);
  };
  useEffect(() => {
    mounted.current = true;
    const hidden = () => { if (document.hidden) cancel(); };
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      mounted.current = false;
      cancel();
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);
  // Filtering while dragging must not drop onto a now-hidden task.
  const ids = items.map(item => item.id).join('|');
  useEffect(() => { cancel(); }, [scope, ids]);
  useEffect(() => { if (drag.current) drag.current.rows = null; }, [visible]);

  const save = async (id, targetId, placement) => {
    if (pending.current) return;
    const next = moveDnsGuard(currentOrder, id, targetId, placement);
    if (next.every((value, index) => value === currentOrder[index])) return;
    if (onSaving(true) === false) { toast('正在保存排序，请稍候'); return; }
    pending.current = true;
    setSaving(true);
    setPreview(next);
    try {
      const data = await api('/api/dns-guards/order', { method: 'PUT', timeoutMs: 15000, body: JSON.stringify({ id, targetId, placement }) });
      onState(current => ({ ...current, dnsGuardOrder: data.dnsGuardOrder }));
      toast('排序已保存');
    } catch (error) { toast(`排序保存失败：${error.message}`); }
    finally {
      pending.current = false;
      onSaving(false);
      if (mounted.current) { setSaving(false); setPreview(null); }
    }
  };

  const track = (timestamp, final = false) => {
    const value = drag.current;
    if (!value) return;
    if (value.moved) {
      if (!value.rows) {
        const offset = value.scroller.scrollTop;
        value.rows = [...(root.current?.querySelectorAll('[data-guard-sort-id]') || [])]
          .filter(row => row.dataset.guardSortId !== value.id)
          .map(row => { const rect = row.getBoundingClientRect(); return { id: row.dataset.guardSortId, center: (rect.top + rect.bottom) / 2 + offset }; });
      }
      const bounds = value.scroller === document.scrollingElement
        ? { top: 0, bottom: window.innerHeight } : value.scroller.getBoundingClientRect();
      const edge = Math.min(64, (bounds.bottom - bounds.top) / 4);
      const speed = value.y < bounds.top + edge ? -1 : value.y > bounds.bottom - edge ? 1 : 0;
      const elapsed = Math.min(32, Math.max(0, timestamp - (value.lastFrameAt ?? timestamp - 16)));
      value.lastFrameAt = timestamp;
      if (speed && !final) value.scroller.scrollTop += speed * .75 * elapsed;
      // A held pointer needs no repeated layout reads unless auto-scroll moved
      // the list. Keep dragging cheap even with hundreds of tasks.
      if (!final && value.lastY === value.y && value.lastScrollTop === value.scroller.scrollTop) {
        frame.current = requestAnimationFrame(track);
        return;
      }
      value.lastY = value.y;
      value.lastScrollTop = value.scroller.scrollTop;
      const y = value.y + value.scroller.scrollTop;
      let low = 0, high = value.rows.length;
      while (low < high) { const mid = (low + high) >>> 1; if (value.rows[mid].center < y) low = mid + 1; else high = mid; }
      const previous = value.rows[low - 1], following = value.rows[low];
      const row = !following || (previous && y - previous.center < following.center - y) ? previous : following;
      const target = row ? { id: value.id, targetId: row.id, placement: y < row.center ? 'before' : 'after' } : null;
      value.target = target;
      setDragging(old => old?.targetId === target?.targetId && old?.placement === target?.placement ? old : target);
    }
    if (!final) frame.current = requestAnimationFrame(track);
  };

  const start = (event, id) => {
    if (pending.current || visible.length < 2 || (event.pointerType === 'mouse' && event.button !== 0) || event.isPrimary === false) return;
    event.preventDefault();
    cancel();
    let scroller = root.current?.parentElement;
    while (scroller && (!/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) || scroller.scrollHeight <= scroller.clientHeight)) scroller = scroller.parentElement;
    drag.current = { id, handle: event.currentTarget, pointerId: event.pointerId, y: event.clientY, startY: event.clientY, startX: event.clientX, moved: false, scroller: scroller || document.scrollingElement };
    event.currentTarget.setPointerCapture(event.pointerId);
    frame.current = requestAnimationFrame(track);
  };
  const move = event => {
    const value = drag.current;
    if (!value || value.pointerId !== event.pointerId) return;
    value.y = event.clientY;
    value.moved ||= Math.hypot(event.clientX - value.startX, event.clientY - value.startY) > 5;
  };
  const finish = event => {
    const value = drag.current;
    if (!value || value.pointerId !== event.pointerId) return;
    // Hit-test the final pointer position even if no animation frame ran yet.
    move(event);
    cancelAnimationFrame(frame.current);
    track(value.lastFrameAt ?? 0, true);
    const target = value.moved && value.target;
    cancel();
    if (target) void save(target.id, target.targetId, target.placement);
  };

  return <div className={`guard-sort-list${saving ? ' is-saving' : ''}`} ref={root} aria-busy={saving}>
    {visible.map((item, index) => <div key={item.id} data-guard-sort-id={item.id}
      className={`guard-sort-item${dragging?.id === item.id ? ' is-dragging' : ''}${dragging?.targetId === item.id ? ` drop-${dragging.placement}` : ''}`}>
      <button className="guard-sort-handle" type="button" disabled={saving || visible.length < 2}
        aria-label={`拖动排序：${item.name}`} title="拖动排序，也可用上下方向键移动"
        onPointerDown={event => start(event, item.id)} onPointerMove={move} onPointerUp={finish}
        onPointerCancel={cancel} onLostPointerCapture={cancel}
        onKeyDown={event => {
          if (event.key === 'Escape') { cancel(); return; }
          const target = visible[index + (event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0)];
          if (!['ArrowUp', 'ArrowDown'].includes(event.key) || !target) return;
          event.preventDefault();
          cancel();
          void save(item.id, target.id, event.key === 'ArrowUp' ? 'before' : 'after');
        }}>
        <GripVertical size={18} aria-hidden="true" />
      </button>
      {children(item)}
    </div>)}
  </div>;
}
