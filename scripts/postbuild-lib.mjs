// Prepend the @webgpu/types reference to the emitted entry .d.ts.
//
// tsc strips triple-slash `/// <reference>` directives it considers unused, so
// the one in src/index.ts does not survive into lib/index.d.ts. Without it,
// consumers importing kiln-render hit "Cannot find name 'GPUDevice'" unless they
// add @webgpu/types to their own tsconfig. Injecting it into the published entry
// makes the ambient GPU types available automatically — zero consumer config.
//
// Idempotent: skips if the reference is already the first line.
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'lib/index.d.ts';
const ref = '/// <reference types="@webgpu/types" />\n';
const contents = readFileSync(file, 'utf8');

if (contents.startsWith(ref)) {
  console.log('[postbuild-lib] @webgpu/types reference already present');
} else {
  writeFileSync(file, ref + contents);
  console.log(`[postbuild-lib] injected ${ref.trim()} into ${file}`);
}
