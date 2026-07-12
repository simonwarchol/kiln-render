/**
 * GoatCounter helpers shared by the viewers.
 *
 * Pageviews vs. events (see the two-part model):
 *  - The clean-path override (so camera-state query strings don't explode into
 *    one pageview row each) is set in each viewer's index.html *before*
 *    count.js loads — it can't live here because it must exist before the
 *    script tag runs.
 *  - This module fires the low-cardinality *events* that capture what actually
 *    happened: which dataset loaded, which render mode. Camera/zoom/etc. are
 *    noise and deliberately never tracked.
 */

declare global {
  interface Window {
    goatcounter?: {
      count?: (opts: { path: string; title?: string; event?: boolean }) => void;
      // Settings object read by count.js; `path` is assigned in index.html.
      path?: (p: string) => string;
    };
  }
}

/** Fire a GoatCounter event. Event paths must NOT start with '/'. */
export function trackEvent(path: string, title?: string): void {
  window.goatcounter?.count?.({ path, title, event: true });
}

/** Collapse a free-form string to a low-cardinality, slash-free event slug. */
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'unknown'
  );
}

/** "someone loaded dataset X" — keep names low-cardinality. */
export function trackDataset(name: string): void {
  trackEvent('dataset-loaded/' + slug(name), 'Dataset loaded');
}

/** "someone viewed/switched to render mode X" (dvr / mip / iso / slice / …). */
export function trackRenderMode(mode: string): void {
  trackEvent('render-mode/' + slug(mode), 'Render mode');
}
