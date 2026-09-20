import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

export default function Dialog({ title, onClose, footer, children, wide = false, xwide = false, className = '' }) {
  const titleId = useId();
  const dialog = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    // Focus the container without opening a phone's software keyboard.
    if (!element.contains(document.activeElement)) element.focus({ preventScroll: true });
    const keydown = (event) => {
      const dialogs = document.querySelectorAll('.dialog[aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== element) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current?.(); }
      if (event.key !== 'Tab') return;
      const controls = [...element.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex]')]
        .filter((control) => !control.disabled && control.tabIndex >= 0 && control.getClientRects().length);
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); element.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === element)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === element)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  // Fixed overlays must escape surface/backdrop-filter containing blocks.
  return createPortal(
    <div className="dialog-backdrop" onClick={onClose}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className={`dialog ${wide ? 'wide' : ''} ${xwide ? 'xwide' : ''} ${className}`} onClick={(event) => event.stopPropagation()}>
        <div className="dialog-head"><strong id={titleId}>{title}</strong><button className="icon-button" type="button" aria-label="关闭" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
        </button></div>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-footer">{footer}</div> : null}
      </div>
    </div>, document.body
  );
}
