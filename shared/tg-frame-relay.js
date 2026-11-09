// Apply transport backpressure before a slow viewer accumulates megabytes and
// loses its connection. A VNC byte stream cannot discard individual frames.
export function relayTgFrame(source, target, data, { binary = true, limit = 4 * 1024 ** 2 } = {}) {
  if (target.readyState !== 1) return;
  if (target.bufferedAmount + data.length > limit) { target.close(1013, '画面连接过慢，请重连'); return; }
  target.send(data, { binary }, error => {
    if (error) { target.close(1011); return; }
    if (target.readyState === 1 && target.bufferedAmount < 256 * 1024) source.resume();
  });
  if (target.bufferedAmount >= 256 * 1024) source.pause();
}
