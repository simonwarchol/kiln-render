import { copyFileSync, mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { Plugin } from 'vite';

/**
 * Copies just the favicon files from public/ into the build output.
 *
 * The example/site builds set `build.copyPublicDir: false` so Vite does NOT
 * copy all of public/ into dist — public/ holds ~15 GB of local test datasets
 * (dev-only; the deployed site streams from CloudFront), and copying them into
 * every build output filled the disk. Dev serving is unaffected (publicDir
 * still serves everything). This plugin re-adds only the two small favicon
 * assets the HTML references at the site root.
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

/**
 * Writes a back-compat stub at dist/app/multichannel/ so old share links
 * (`/app/multichannel/?…`) redirect into the unified `/app/?…` viewer.
 */
export function legacyMultichannelRedirect(): Plugin {
  let outDir = 'dist/app';
  return {
    name: 'kiln-legacy-multichannel-redirect',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const dir = resolve(outDir, 'multichannel');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        resolve(dir, 'index.html'),
        `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Redirecting…</title>
<script>location.replace('../'+location.search+location.hash);</script>
<meta http-equiv="refresh" content="0; url=../">
</head>
<body>
<p>The multichannel viewer now lives at <a href="../">/app/</a>. Redirecting…</p>
</body>
</html>
`,
      );
    },
  };
}
