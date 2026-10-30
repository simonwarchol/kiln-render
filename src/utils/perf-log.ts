/**
 * Opt-in performance logging, observation only: turn it on with
 * `localStorage.setItem("kiln:perf", "1")` and reload. Counts and timings
 * print as one `[kiln perf]` line every 2 s while anything happens; events
 * (a channel backfill, a converged image) print when they end.
 */
export const perfOn: boolean = (() => {
  try {
    return globalThis.localStorage?.getItem("kiln:perf") === "1";
  } catch {
    return false;
  }
})();

const FLUSH_MS = 2000;

const counts = new Map<string, number>();
const samples = new Map<string, number[]>();
/** Samples that aren't durations (printed without "ms"). */
const plain = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;

export function perfCount(name: string, n = 1): void {
  counts.set(name, (counts.get(name) ?? 0) + n);
  timer ??= setTimeout(flush, FLUSH_MS);
}

/** A duration in ms, summarised as count, median, 90th percentile and max. */
export function perfSample(name: string, ms: number): void {
  let list = samples.get(name);
  if (!list) {
    list = [];
    samples.set(name, list);
  }
  list.push(ms);
  timer ??= setTimeout(flush, FLUSH_MS);
}

/** A quantity other than a duration, summarised as `perfSample` does. */
export function perfValue(name: string, value: number): void {
  plain.add(name);
  perfSample(name, value);
}

export function perfEvent(message: string): void {
  console.log(`[kiln perf] ${message}`);
}

export const ms = (v: number) => `${v.toFixed(1)} ms`;

function flush(): void {
  timer = null;
  const parts: string[] = [];
  for (const [name, list] of samples) {
    list.sort((a, b) => a - b);
    const at = (q: number) =>
      list[Math.min(list.length - 1, Math.floor(list.length * q))] ?? 0;
    const f = plain.has(name)
      ? (v: number) => Math.round(v).toLocaleString()
      : ms;
    parts.push(
      `${name}: n=${list.length} p50=${f(at(0.5))} p90=${f(at(0.9))} max=${f(at(1))}`,
    );
  }
  for (const [name, n] of counts) parts.push(`${name}: ${n}`);
  samples.clear();
  counts.clear();
  if (parts.length > 0) console.log(`[kiln perf] ${parts.join(" | ")}`);
}
