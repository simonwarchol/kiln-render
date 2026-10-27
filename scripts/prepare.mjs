/**
 * `prepare`: build lib/ when it's missing — it isn't committed, so a git
 * dependency (`github:simonwarchol/kiln-render#<commit>`) builds it on
 * install — and, in a git checkout, install the git hooks.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync("lib/index.d.ts")) {
  execSync("pnpm run build:lib", { stdio: "inherit" });
}
if (existsSync(".git")) {
  try {
    execSync("pnpm exec lefthook install", { stdio: "inherit" });
  } catch {
    // Not a working checkout (e.g. pnpm's clone of a git dependency).
  }
}
