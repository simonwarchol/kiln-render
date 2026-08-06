/**
 * Pure helpers for choosing basic vs multichannel viewer URLs.
 * Kept free of kiln-render imports so unit tests can cover them directly.
 */

/** Site root derived from this viewer's Vite base (`…/app/` or `…/app/multichannel/`). */
export function viewerSiteRoot(baseUrl: string): string {
  return baseUrl.replace(/app\/(multichannel\/)?$/, '');
}

/**
 * If `input` is a Kiln viewer share link (`/app/` or `/app/multichannel/` + viewer
 * query params), return a navigation href. Same-origin → path+search; else full URL.
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
  return u.origin === currentOrigin
    ? `${u.pathname}${u.search}${u.hash}`
    : u.href;
}

/**
 * Choose basic vs multichannel viewer path for a dataset URL.
 * `numChannels > 1` → multichannel; `1` → basic; `null` (unknown/sharded) → stay put.
 */
export function datasetViewerHref(
  datasetUrl: string,
  numChannels: number | null,
  opts: { baseUrl: string; currentPathname: string },
): string {
  const siteRoot = viewerSiteRoot(opts.baseUrl);
  let path = opts.currentPathname;
  if (numChannels !== null && numChannels > 1) {
    path = `${siteRoot}app/multichannel/`;
  } else if (numChannels === 1) {
    path = `${siteRoot}app/`;
  }
  return `${path}?dataset=${encodeURIComponent(datasetUrl)}`;
}

/** Local `?local=true` load — pick viewer path from channel count. */
export function localViewerHref(
  numChannels: number | null,
  opts: { baseUrl: string; currentPathname: string },
): string {
  const siteRoot = viewerSiteRoot(opts.baseUrl);
  let path = opts.currentPathname;
  if (numChannels !== null && numChannels > 1) {
    path = `${siteRoot}app/multichannel/`;
  } else if (numChannels === 1) {
    path = `${siteRoot}app/`;
  }
  return `${path}?local=true`;
}
