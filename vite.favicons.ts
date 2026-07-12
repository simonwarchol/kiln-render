import { copyFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import type { Plugin } from 'vite';

/**
 * Copies just the favicon files from public/ into the build output.
 *
 * The example/site builds set `build.copyPublicDir: false` so Vite does NOT
 * copy all of public/ into dist — public/ holds ~15 GB of local test datasets
 * (dev-only; the deployed site streams from CloudFront), and copying them into
 * every one of the three build outputs filled the disk. Dev serving is
 * unaffected (publicDir still serves everything). This plugin re-adds only the
 * two small favicon assets the HTML references at the site root.
 */
export function copyFavicons(): Plugin {
  const files = ['favicon-32x32.png', 'apple-touch-icon.png'];
  let outDir = 'dist';
  return {
    name: 'kiln-copy-favicons',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      mkdirSync(outDir, { recursive: true });
      for (const f of files) {
        copyFileSync(resolve(__dirname, 'public', f), resolve(outDir, f));
      }
    },
  };
}
