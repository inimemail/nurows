// One shared, frame-batched listener; never resize each terminal on viewport scroll.
export function trackMobileViewport(win = window, doc = document) {
  const viewport = win.visualViewport;
  const media = win.matchMedia('(max-width: 760px)');
  const style = doc.documentElement.style;
  const names = ['--mobile-viewport-height', '--mobile-viewport-top', '--mobile-viewport-bottom'];
  let frame = null;
  let previous = [];
  const update = () => {
    frame = null;
    if (!media.matches || (viewport && viewport.scale !== 1)) {
      names.forEach((name) => style.removeProperty(name));
      previous = [];
      return;
    }
    const height = viewport?.height || win.innerHeight;
    const top = viewport?.offsetTop || 0;
    const values = [`${height}px`, `${top}px`, `${Math.max(0, win.innerHeight - height - top)}px`];
    values.forEach((value, index) => { if (previous[index] !== value) style.setProperty(names[index], value); });
    previous = values;
  };
  const schedule = () => { if (frame === null) frame = win.requestAnimationFrame(update); };
  update();
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  win.addEventListener('resize', schedule);
  media.addEventListener('change', schedule);
  return () => {
    if (frame !== null) win.cancelAnimationFrame(frame);
    viewport?.removeEventListener('resize', schedule);
    viewport?.removeEventListener('scroll', schedule);
    win.removeEventListener('resize', schedule);
    media.removeEventListener('change', schedule);
    names.forEach((name) => style.removeProperty(name));
  };
}
