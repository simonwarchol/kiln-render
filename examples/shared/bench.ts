/**
 * Kiln fetch-pattern benchmark driver (in-page, single-shot).
 *
 * Activates only on `?bench=1`. Measures the initial load of whatever dataset
 * the URL points at: time-to-converge, number of fetches, bytes, brick
 * lifecycle counts, and the per-stage pipeline breakdown. No camera
 * interaction — you point the URL at a dataset, it measures the load, prints a
 * compact block you can copy-paste for A/B comparison.
 *
 * Results are emitted three ways:
 *   1. a human-readable block + `KILN_BENCH_RESULT <json>` in the console
 *   2. `window.__KILN_BENCH_RESULT = report`  (pollable via CDP/puppeteer)
 *   3. POST to `?report=<url>` if present
 *
 * Structural typing (BenchViewer) keeps this decoupled from the library types.
 *
 * URL params:
 *   ?bench=1              enable
 *   ?benchTimeout=120000  give-up timeout (ms) if it never converges
 *   ?benchStable=8        consecutive stable polls required to call it converged
 *   ?benchLabel=<name>    label echoed into the report
 *   ?report=<url>         POST the JSON report here when done
 */

interface BenchStats {
  desiredCount: number;
  loadedCount: number;
  pendingCount: number;
  requestCount: number;
  totalBytesDownloaded: number;
  bricksDispatched: number;
  bricksCommitted: number;
  bricksCancelled: number;
  bricksDiscarded: number;
  evictedCount: number;
  avgBrickLatencyMs: number;
  timeToFirstRender: number | null;
  pipelineTimings: {
    avgQueueMs: number;
    avgFetchMs: number;
    avgAssemblyMs: number;
    avgUploadMs: number;
    chunkCacheHitRatio?: number;
  };
}

/** Minimal structural view of KilnViewer — only what the bench reads. */
export interface BenchViewer {
  renderer: { isConverged: boolean; numChannels: number };
  streamingManager: { baseLodLoaded: boolean; getStats(): BenchStats };
  metadata: { name: string };
}

export interface BenchReport {
  label: string;
  /** Raw URL query string — makes which feature flags (?p2=1 etc.) were active self-evident when pasted. */
  query: string;
  dataset: string;
  numChannels: number;
  /** ms from page open to converged (the headline number). */
  convergeMs: number;
  /** ms from load start to first rendered frame, from the streaming manager. */
  timeToFirstRenderMs: number | null;
  timedOut: boolean;
  requestCount: number;
  bytesDownloaded: number;
  bricksDispatched: number;
  bricksCommitted: number;
  bricksCancelled: number;
  bricksDiscarded: number;
  evicted: number;
  loadedCount: number;
  desiredCount: number;
  avgBrickLatencyMs: number;
  chunkCacheHitRatio: number;
  timings: { queueMs: number; fetchMs: number; assemblyMs: number; uploadMs: number };
  userAgent: string;
}

const POLL_MS = 100;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function num(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Wait until the pipeline is idle and the image has converged, held stable for
 * `stablePolls` consecutive polls (debounce: a transient `pendingCount===0`
 * mid-stream doesn't count). Returns whether it settled before the timeout.
 */
async function waitForConverged(v: BenchViewer, timeoutMs: number, stablePolls: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  let stable = 0;
  while (performance.now() < deadline) {
    const s = v.streamingManager.getStats();
    const idle = s.pendingCount === 0 && v.streamingManager.baseLodLoaded && v.renderer.isConverged;
    stable = idle ? stable + 1 : 0;
    if (stable >= stablePolls) return true;
    await sleep(POLL_MS);
  }
  return false;
}

function formatReport(r: BenchReport): string {
  const mb = (b: number) => (b / 1e6).toFixed(1);
  const pad = (label: string) => (label + ':').padEnd(20);
  return [
    '=== KILN BENCH ===',
    `${pad('dataset')}${r.dataset} (${r.numChannels}ch)`,
    `${pad('label')}${r.label}`,
    `${pad('flags')}${r.query || '(none)'}`,
    `${pad('time to converge')}${Math.round(r.convergeMs)} ms${r.timedOut ? '  ⚠ TIMED OUT (did not converge)' : ''}`,
    `${pad('time to 1st render')}${r.timeToFirstRenderMs === null ? 'n/a' : Math.round(r.timeToFirstRenderMs) + ' ms'}`,
    `${pad('requests')}${r.requestCount}`,
    `${pad('downloaded')}${mb(r.bytesDownloaded)} MB`,
    `${pad('bricks')}dispatched ${r.bricksDispatched} · committed ${r.bricksCommitted} · cancelled ${r.bricksCancelled} · discarded ${r.bricksDiscarded}`,
    `${pad('evicted')}${r.evicted}`,
    `${pad('avg brick latency')}${Math.round(r.avgBrickLatencyMs)} ms`,
    `${pad('chunk cache hit')}${(r.chunkCacheHitRatio * 100).toFixed(0)}%`,
    `${pad('pipeline avg ms')}queue ${r.timings.queueMs.toFixed(0)} · fetch ${r.timings.fetchMs.toFixed(0)} · assembly ${r.timings.assemblyMs.toFixed(0)} · upload ${r.timings.uploadMs.toFixed(0)}`,
    `${pad('resident/desired')}${r.loadedCount} / ${r.desiredCount}`,
    '==================',
  ].join('\n');
}

/**
 * Run the benchmark if `?bench=1`. Call once, right after the viewer is created.
 */
export async function maybeRunBench(viewer: BenchViewer): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  if (params.get('bench') !== '1') return;

  const timeoutMs = num(params, 'benchTimeout', 120000);
  const stablePolls = num(params, 'benchStable', 8);
  const label = params.get('benchLabel') ?? 'run';
  const reportUrl = params.get('report');

  const settled = await waitForConverged(viewer, timeoutMs, stablePolls);
  // performance.now() is ms since page navigation start, so this is the full
  // open→converge wall-clock (WebGPU init + metadata + base load + refinement).
  const convergeMs = performance.now();
  const s = viewer.streamingManager.getStats();

  const report: BenchReport = {
    label,
    query: window.location.search,
    dataset: viewer.metadata.name,
    numChannels: viewer.renderer.numChannels,
    convergeMs,
    timeToFirstRenderMs: s.timeToFirstRender,
    timedOut: !settled,
    requestCount: s.requestCount,
    bytesDownloaded: s.totalBytesDownloaded,
    bricksDispatched: s.bricksDispatched,
    bricksCommitted: s.bricksCommitted,
    bricksCancelled: s.bricksCancelled,
    bricksDiscarded: s.bricksDiscarded,
    evicted: s.evictedCount,
    loadedCount: s.loadedCount,
    desiredCount: s.desiredCount,
    avgBrickLatencyMs: s.avgBrickLatencyMs,
    chunkCacheHitRatio: s.pipelineTimings.chunkCacheHitRatio ?? 0,
    timings: {
      queueMs: s.pipelineTimings.avgQueueMs,
      fetchMs: s.pipelineTimings.avgFetchMs,
      assemblyMs: s.pipelineTimings.avgAssemblyMs,
      uploadMs: s.pipelineTimings.avgUploadMs,
    },
    userAgent: navigator.userAgent,
  };

  const json = JSON.stringify(report);
  // eslint-disable-next-line no-console
  console.log(formatReport(report) + '\nKILN_BENCH_RESULT ' + json);
  (window as unknown as { __KILN_BENCH_RESULT?: BenchReport }).__KILN_BENCH_RESULT = report;

  if (reportUrl) {
    try {
      await fetch(reportUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[bench] failed to POST report:', e);
    }
  }
}
