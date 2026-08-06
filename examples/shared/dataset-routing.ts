/**
 * Pure helpers for dataset-dialog navigation and Kiln share-link handling.
 * Single viewer app at /app/ — channel count no longer picks a separate deploy path.
 */

/** Site root derived from this viewer's Vite base (`…/app/` or legacy `…/app/multichannel/`). */
export function viewerSiteRoot(baseUrl: string): string {
  return baseUrl.replace(/app\/(multichannel\/)?$/, '');
}

/**
 * If `input` is a Kiln viewer share link (`/app/` or legacy `/app/multichannel/`),
 * return a navigation href into the unified `/app/` viewer (preserving query/hash).
 *
 * - Same origin: rewrite multichannel path → `/app/` + search
 * - Other origins: full URL with path normalized to `/app/`
 */
export function tryKilnViewerHref(input: string, currentOrigin: string): string | null {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return null;
  }
  if (!/\/app\/(multichannel\/)?(index\.html)?$/.test(u.pathname)) return null;
  const viewerKeys = ['dataset', 'local', 'channels', 'mode', 'cam', 'slice', 'slices'];
  if (!viewerKeys.some(k => u.searchParams.has(k))) return null;

  // Legacy /app/multichannel/ share links → unified /app/
  const path = u.pathname.replace(/\/app\/multichannel\/(index\.html)?$/, '/app/');
  const searchAndHash = `${u.search}${u.hash}`;

  return u.origin === currentOrigin
    ? `${path}${searchAndHash}`
    : `${u.origin}${path}${searchAndHash}`;
}

/** Navigate to the unified viewer with a remote dataset URL. */
export function datasetViewerHref(
  datasetUrl: string,
  opts: { baseUrl: string; currentPathname: string },
): string {
  const siteRoot = viewerSiteRoot(opts.baseUrl);
  // Prefer /app/ even if somehow opened under a legacy multichannel base.
  const path = `${siteRoot}app/`;
  return `${path}?dataset=${encodeURIComponent(datasetUrl)}`;
}

/** Local `?local=true` load on the unified viewer. */
export function localViewerHref(opts: { baseUrl: string; currentPathname: string }): string {
  const siteRoot = viewerSiteRoot(opts.baseUrl);
  return `${siteRoot}app/?local=true`;
}
