/** Shared top bar — wordmark, dataset name, load button (left); share + GitHub (right). */

const LOAD_ICON_SVG = '<svg viewBox="0 0 16 16"><path d="M1 3.5A1.5 1.5 0 0 1 2.5 2h2.764c.958 0 1.76.56 2.311 1.184C7.985 3.648 8.48 4 9 4h4.5A1.5 1.5 0 0 1 15 5.5v.64c.57.265.94.876.856 1.546l-.64 5.124A2.5 2.5 0 0 1 12.733 15H3.266a2.5 2.5 0 0 1-2.481-2.19l-.64-5.124A1.5 1.5 0 0 1 1 6.14V3.5zM2 6h12v-.5a.5.5 0 0 0-.5-.5H9c-.964 0-1.71-.629-2.174-1.154C6.374 3.334 5.82 3 5.264 3H2.5a.5.5 0 0 0-.5.5V6z"/></svg>';
const SHARE_ICON_SVG = '<svg viewBox="0 0 16 16"><path d="M13.5 1a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM11 2.5a2.5 2.5 0 1 1 .603 1.628l-6.718 3.12a2.5 2.5 0 0 1 0 1.504l6.718 3.12a2.5 2.5 0 1 1-.488.876l-6.718-3.12a2.5 2.5 0 1 1 0-3.256l6.718-3.12A2.5 2.5 0 0 1 11 2.5zm-8.5 4a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm11 5.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z"/></svg>';
const GITHUB_ICON_SVG = '<svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

export interface TopBarOptions {
  githubUrl?: string;
  /** Show the "beta" tag next to the wordmark (multichannel viewer only). */
  beta?: boolean;
}

export interface TopBar {
  setDatasetName(name: string): void;
  /** Show/hide the beta tag on the wordmark (e.g. after detecting multichannel). */
  setBeta(enabled: boolean): void;
}

export function mountTopBar(opts: TopBarOptions = {}): TopBar {
  const githubUrl = opts.githubUrl ?? 'https://github.com/MPanknin/kiln-render';

  // The wordmark links back to the gallery. Derive its URL from this viewer's
  // base (/app/ or legacy /app/multichannel/, plus any preview prefix) by
  // stripping the app segment — base-agnostic across production and previews.
  const galleryUrl =
    import.meta.env.BASE_URL.replace(/app\/(multichannel\/)?$/, '') + 'gallery.html';

  const bar = document.createElement('div');
  bar.className = 'top-bar';
  bar.innerHTML = `
    <div class="top-bar-group">
      <a class="wordmark" href="${galleryUrl}" title="Back to gallery">Kiln${opts.beta ? '<sup>beta</sup>' : ''}</a>
      <span class="dataset-name" id="dataset-name"></span>
      <button id="load-dataset-btn" class="load-dataset-btn" title="Load Dataset">
        ${LOAD_ICON_SVG}<span>Load</span>
      </button>
    </div>
    <div class="top-bar-group">
      <button id="share-btn" class="toolbar-btn" title="Copy link to current view">${SHARE_ICON_SVG}</button>
      <a href="${githubUrl}" target="_blank" rel="noopener" class="toolbar-btn" title="View on GitHub">${GITHUB_ICON_SVG}</a>
    </div>
  `;
  document.body.appendChild(bar);

  const nameEl = document.getElementById('dataset-name');
  const wordmark = bar.querySelector('.wordmark') as HTMLAnchorElement | null;
  return {
    setDatasetName(name: string) {
      if (nameEl) {
        nameEl.textContent = name;
        nameEl.title = name;
      }
    },
    setBeta(enabled: boolean) {
      if (!wordmark) return;
      const label = enabled ? 'Kiln<sup>beta</sup>' : 'Kiln';
      if (wordmark.innerHTML !== label) wordmark.innerHTML = label;
    },
  };
}
