// Prepend the @webgpu/types reference to the emitted entry .d.ts.
//
// tsc strips triple-slash `/// <reference>` directives it considers unused, so
// the one in src/index.ts does not survive into lib/index.d.ts. Without it,
// consumers importing kiln-render hit "Cannot find name 'GPUDevice'" unless they
// add @webgpu/types to their own tsconfig. Injecting it into the published entry
// makes the ambient GPU types available automatically — zero consumer config.
//
// Idempotent: skips if the reference is already the first line.
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const file = "lib/index.d.ts";
const ref = '/// <reference types="@webgpu/types" />\n';
const contents = readFileSync(file, "utf8");

if (contents.startsWith(ref)) {
  console.log("[postbuild-lib] @webgpu/types reference already present");
} else {
  writeFileSync(file, ref + contents);
  console.log(`[postbuild-lib] injected ${ref.trim()} into ${file}`);
}

// Ship Brush (vendor/brush-js) inside lib/: the bundle imports it as
// ./brush-js/brush_js.js (vite.lib.config.ts), and installed packages have no
// vendor/ folder. Point the declarations at the copy too.
const brushOut = "lib/brush-js";
mkdirSync(brushOut, { recursive: true });
for (const name of [
  "brush_js.js",
  "brush_js.d.ts",
  "brush_js_bg.wasm",
  "brush_js_bg.wasm.d.ts",
]) {
  copyFileSync(join("vendor/brush-js", name), join(brushOut, name));
}
const rewriteDts = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (path !== brushOut) rewriteDts(path);
    } else if (path.endsWith(".d.ts")) {
      const text = readFileSync(path, "utf8");
      if (!text.includes('"brush-js"')) continue;
      const depth = path.split("/").length - 2; // lib/a/b.d.ts → 1
      const rel = `${depth === 0 ? "./" : "../".repeat(depth)}brush-js/brush_js.js`;
      writeFileSync(path, text.replaceAll('"brush-js"', `"${rel}"`));
    }
  }
};
rewriteDts("lib");
console.log(`[postbuild-lib] copied Brush into ${brushOut}/`);
