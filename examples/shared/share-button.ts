/** Shared "copy current view URL to clipboard" wiring for the #share-btn toolbar button. */

import type { Toast } from './toast.js';

export interface ShareButtonOptions {
  /** Local datasets can't be shared via link (no stable URL to point at). */
  isLocalZarr: boolean;
  /** Builds the shareable URL from current viewer state — viewer-specific. */
  buildShareUrl: () => string;
  toast: Toast;
}

export function setupShareButton(opts: ShareButtonOptions): void {
  const shareBtn = document.getElementById('share-btn');
  if (!shareBtn) return;

  shareBtn.addEventListener('click', () => {
    if (opts.isLocalZarr) {
      opts.toast.show('Local datasets cannot be shared via link', 2500);
      return;
    }

    // Single feedback signal (IA-7) — the button-state morph is where the
    // user's eyes already are. The toast stays reserved for the error case
    // above, where there's no button state to morph into.
    const url = opts.buildShareUrl();
    navigator.clipboard.writeText(url).then(() => {
      shareBtn.classList.add('copied');
      setTimeout(() => shareBtn.classList.remove('copied'), 1500);
    });
  });
}
