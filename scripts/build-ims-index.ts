/**
 * Save an Imaris file's chunk indexes ("<file>.ims.index"), so kiln skips
 * reading the file's chunk B-trees: hundreds of small scattered reads per
 * channel and resolution level in a large file. Host the output next to the
 * .ims under the same name plus ".index"; kiln looks for it there.
 *
 * Usage: npx tsx scripts/build-ims-index.ts <file.ims | URL> [output] [--channels 0,1,2]
 *   output: default "<file>.ims.index" beside a local file, or the URL's
 *   file name plus ".index" in the current directory.
 *
 * Example:
 *   npx tsx scripts/build-ims-index.ts https://example.com/data/scan.ims
 */

import { openAsBlob } from "node:fs";
import { writeFile } from "node:fs/promises";
import {
  blobRangeSource,
  cachedRangeSource,
  Hdf5File,
  httpRangeSource,
  type RangeSource,
} from "../src/data/hdf5/index.js";
import { buildImsChunkIndex } from "../src/data/imaris/chunk-index-file.js";
import { Limiter } from "../src/utils/limiter.js";

/**
 * At most 16 reads at once, retrying transient failures: Node opens as many
 * connections as asked, and S3 drops some of a flood of hundreds.
 */
function politely(src: RangeSource): RangeSource {
  const limiter = new Limiter(16);
  return {
    read: (offset, length, signal) =>
      limiter.run(async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await src.read(offset, length, signal);
          } catch (e) {
            if (attempt >= 3 || /HTTP 4\d\d/.test(String(e))) throw e;
            await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
          }
        }
      }),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf("--channels");
  const channels =
    at >= 0 ? args.splice(at, 2)[1]!.split(",").map(Number) : undefined;
  const [input, output] = args;
  if (!input) {
    console.error(
      "Usage: npx tsx scripts/build-ims-index.ts <file.ims | URL> [output] [--channels 0,1,2]",
    );
    process.exit(1);
  }
  const remote = /^https?:\/\//.test(input);
  const out =
    output ??
    (remote
      ? `${decodeURIComponent(new URL(input).pathname.split("/").pop()!)}.index`
      : `${input}.index`);

  const raw = remote
    ? politely(httpRangeSource(input))
    : blobRangeSource(await openAsBlob(input));
  const meta = cachedRangeSource(raw, { pageSize: 16 * 1024, maxPages: 8192 });
  // Imaris keeps its group metadata at the head of the file.
  await meta.read(0, 1024 * 1024).catch(() => undefined);
  const file = await Hdf5File.open(raw, { meta });

  const t0 = performance.now();
  const bytes = await buildImsChunkIndex(file, {
    channels,
    onProgress: (done, total) =>
      process.stderr.write(`\rIndexed ${done}/${total} datasets`),
  });
  await writeFile(out, bytes);
  const s = ((performance.now() - t0) / 1000).toFixed(1);
  process.stderr.write(
    `\nWrote ${out} (${(bytes.length / 1024).toFixed(0)} KB) in ${s} s\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
