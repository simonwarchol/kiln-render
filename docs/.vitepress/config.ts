import { defineConfig } from 'vitepress';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Kiln site is built by VitePress from this docs/ folder; the unified
// viewer is built via vite.config.ts into dist/app/. VitePress owns the site root
// (dist/), so build order is: site first (it empties dist/), then the viewer
// repopulates dist/app/. See package.json `build:all` and the deploy workflows.
//
// VITE_BASE is the site-root prefix:
//   - production (non-fork kiln-render): '/'  → kilnrender.com/
//   - forks / staging: '/<repo>/'             → <owner>.github.io/<repo>/
//   - branch previews: '/<repo>/preview/<b>/' (or '/preview/<b>/' on prod)
// Default matches vite.config.ts so local `build:all` stays coherent on forks.
const base = process.env.VITE_BASE || '/kiln-render/';
// Absolute origin for sitemap / canonical / og:image. CI sets SITE_ORIGIN to
// the deploy host (kilnrender.com or https://<owner>.github.io). Without it,
// only apex production (`base === '/'`) assumes kilnrender.com — forks must
// not invent that host or links/canonicals point at the wrong site.
const origin = (
  process.env.SITE_ORIGIN ||
  (base === '/' ? 'https://kilnrender.com' : '')
).replace(/\/$/, '');
const siteUrl = origin ? `${origin}${base}` : '';
const repoUrl =
  process.env.VITE_REPO_URL ||
  (process.env.GITHUB_REPOSITORY
    ? `https://github.com/${process.env.GITHUB_REPOSITORY}`
    : 'https://github.com/MPanknin/kiln-render');
const description =
  'A WebGPU renderer that streams large volumetric datasets over HTTP into a bounded VRAM cache.';
// Preview builds (deploy-preview.yml sets VITE_PREVIEW=1) sit under the
// production domain on the public repo, so keep them out of search indexes.
const isPreview = !!process.env.VITE_PREVIEW;

export default defineConfig({
  title: 'Kiln',
  description,
  lang: 'en-US',
  ...(siteUrl ? { sitemap: { hostname: siteUrl } } : {}),
  base,
  // Dark by default (still toggleable) to match the renderer's aesthetic.
  appearance: 'dark',
  // Internal audit docs must not ship in the public site. README.md stays in
  // the build: it's the "Documentation index" every doc footer links back to
  // (via README.md), so it must resolve as a page here and on GitHub alike.
  srcExclude: ['audits/**'],
  head: [
    // Preview builds: never index a staging copy (esp. public-repo previews,
    // which live under the production domain at kilnrender.com/preview/<b>/).
    ...(isPreview
      ? [['meta', { name: 'robots', content: 'noindex, nofollow' }] as [string, Record<string, string>]]
      : []),
    // Back-compat for pre-restructure share links: the viewer used to live at
    // the site root, now it's at /app/. If the landing URL carries viewer query
    // params, bounce to /app/ preserving the query + hash. Runs synchronously in
    // <head> before the landing renders (no flash) and before analytics counts a
    // hit. A bare root URL (no viewer params) falls through to the landing page.
    // Viewer deep-links that land on the site root bounce into the unified /app/.
    ['script', {}, `(function(){var b=${JSON.stringify(base)};var p=location.pathname;if(p!==b&&p!==b+'index.html')return;var k=['dataset','mode','cam','up','scale','lod','sse','wc','ww','iso','tf','tfpts','tfPreset','density','channels','slice','clipMin','clipMax','wireframe','renderScale'];var q=new URLSearchParams(location.search);for(var i=0;i<k.length;i++){if(q.has(k[i])){location.replace(b+'app/'+location.search+location.hash);return;}}})();`],
    ['link', { rel: 'icon', type: 'image/png', sizes: '32x32', href: `${base}favicon-32x32.png` }],
    ['link', { rel: 'apple-touch-icon', href: `${base}apple-touch-icon.png` }],
    // Open Graph / Twitter card — static site-level defaults. Per-page title
    // and description are overridden in transformPageData below. Absolute
    // og:url / og:image only when SITE_ORIGIN (or apex default) is known.
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Kiln' }],
    ['meta', { property: 'og:title', content: 'Kiln' }],
    ['meta', { property: 'og:description', content: description }],
    ...(siteUrl
      ? ([
          ['meta', { property: 'og:url', content: siteUrl }],
          ['meta', { property: 'og:image', content: `${siteUrl}kiln_social.jpg` }],
          ['meta', { name: 'twitter:image', content: `${siteUrl}kiln_social.jpg` }],
        ] as [string, Record<string, string>][])
      : []),
    ['meta', { property: 'og:image:width', content: '1200' }],
    ['meta', { property: 'og:image:height', content: '630' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 'Kiln' }],
    ['meta', { name: 'twitter:description', content: description }],
    ['script', {}, "window.goatcounter = { path: function () { return location.pathname || '/'; } };"],
    ['script', { 'data-goatcounter': 'https://mpanknin.goatcounter.com/count', async: '', src: '//gc.zgo.at/count.js' }],
  ],
  // Per-page canonical URL + OG/Twitter title/description overrides, so each
  // page shares with its own metadata (and picks up any `description:`
  // frontmatter) instead of the site-level defaults.
  transformPageData(pageData) {
    const path = pageData.relativePath.replace(/(index)?\.md$/, '').replace(/\/$/, '');
    const title = pageData.title ? `${pageData.title} | Kiln` : 'Kiln';
    const desc = pageData.description || pageData.frontmatter.description || description;
    pageData.frontmatter.head ??= [];
    pageData.frontmatter.head.push(
      ['meta', { property: 'og:title', content: title }],
      ['meta', { property: 'og:description', content: desc }],
      ['meta', { name: 'twitter:title', content: title }],
      ['meta', { name: 'twitter:description', content: desc }],
    );
    if (siteUrl) {
      const canonical = `${siteUrl}${path ? `${path}.html` : ''}`;
      pageData.frontmatter.head.push(
        ['link', { rel: 'canonical', href: canonical }],
        ['meta', { property: 'og:url', content: canonical }],
      );
    }
  },
  // Rewrite robots.txt Sitemap to this deploy's absolute URL (public/robots.txt
  // is copied as-is otherwise and would keep pointing at kilnrender.com).
  buildEnd(siteConfig) {
    if (!siteUrl) return;
    writeFileSync(
      join(siteConfig.outDir, 'robots.txt'),
      `User-agent: *\nAllow: /\n\nSitemap: ${siteUrl}sitemap.xml\n`,
    );
  },
  themeConfig: {
    nav: [
      { text: 'Docs', link: '/guide/introduction' },
      { text: 'Gallery', link: '/gallery' },
    ],
    sidebar: [
      {
        text: 'Guide',
        collapsed: false,
        items: [
          { text: 'Introduction', link: '/guide/introduction' },
          { text: 'Quick start', link: '/guide/quick-start' },
          { text: 'Loading data', link: '/guide/loading-data' },
          { text: 'URL parameters', link: '/guide/url-parameters' },
          { text: 'FAQ', link: '/guide/faq' },
        ],
      },
      {
        text: 'Data',
        collapsed: false,
        items: [
          { text: 'OME-Zarr', link: '/data/ome-zarr' },
          { text: 'Local files', link: '/data/local-files' },
          { text: 'Sharded binary', link: '/data/sharded-binary' },
          { text: 'Hosting', link: '/data/hosting' },
          { text: 'Troubleshooting', link: '/data/troubleshooting' },
        ],
      },
      {
        text: 'Rendering',
        collapsed: false,
        items: [
          { text: 'Raymarching', link: '/rendering/raymarching' },
          { text: 'Compositing modes', link: '/rendering/compositing' },
          { text: 'Multichannel', link: '/rendering/multichannel' },
          { text: 'Resolution & TAA', link: '/rendering/resolution-taa' },
        ],
      },
      {
        text: 'Architecture',
        collapsed: true,
        items: [
          { text: 'System overview', link: '/architecture/overview' },
          { text: 'Virtual texturing', link: '/architecture/virtual-texturing' },
          { text: 'Streaming manager', link: '/architecture/streaming' },
          { text: 'Network & formats', link: '/architecture/network-formats' },
          { text: 'Memory budget', link: '/architecture/memory-budget' },
          { text: 'Design decisions', link: '/architecture/design-decisions' },
        ],
      },
      {
        text: 'Reference',
        collapsed: true,
        items: [
          { text: 'WebGPU notes', link: '/reference/webgpu' },
          { text: 'References', link: '/reference/references' },
          { text: 'Known issues', link: '/reference/issues' },
        ],
      },
    ],
    socialLinks: [
      { icon: 'github', link: repoUrl },
    ],
    footer: {
      message: 'Apache-2.0',
      copyright:
        '© 2026 <a href="https://github.com/MPanknin" target="_blank" rel="noreferrer">mpanknin</a>',
    },
    search: { provider: 'local' },
  },
  vite: {
    server: {
      // Must be 3000: the CloudFront CDN hosting the demo datasets sends a
      // static Access-Control-Allow-Origin of http://localhost:3000, so the
      // live hero embed's dataset fetch only clears CORS from that port in dev.
      port: 3000,
      strictPort: true,
    },
    build: {
      // outDir (../dist) sits outside VitePress's root (docs/), so Vite won't
      // empty it unless we say so. Emptying here is intentional: the site build
      // runs first and clears dist/, then the viewer builds add dist/app/.
      emptyOutDir: true,
    },
    resolve: {
      alias: {
        // Same aliases the example viewers use, so the live hero embed renders
        // the current repo source rather than a published package.
        'kiln-render': fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
        '@kiln': fileURLToPath(new URL('../../src', import.meta.url)),
      },
    },
  },
  // Build the site into the repo-root dist/ (shared with the viewer builds).
  outDir: fileURLToPath(new URL('../../dist', import.meta.url)),
});
