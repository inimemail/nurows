import RFB from '@novnc/novnc/lib/rfb.js';
import { tgViewerSize } from '../shared/tg-hosting.js';

// noVNC 1.5.0 has no public resolution ceiling. Keep its normal scaling,
// resize debounce and input mapping; bound only the remote resize request.
// Exercise this adapter against a real VNC server when updating noVNC.
export default class TgViewerRFB extends RFB {
  _requestRemoteResize() {
    clearTimeout(this._resizeTimeout);
    this._resizeTimeout = null;
    if (!this._resizeSession || this._viewOnly || !this._supportsSetDesktopSize) return;
    const size = this._screenSize(), bounded = tgViewerSize(size.w, size.h);
    if (!bounded || (this._fbWidth === bounded.width && this._fbHeight === bounded.height)) return;
    RFB.messages.setDesktopSize(this._sock, bounded.width, bounded.height, this._screenID, this._screenFlags);
  }
}
