import { getVirtualRange, virtualRowCount } from "../src/virtual-list.js";

export interface VirtualListBenchmarkResult {
  readonly rows: number;
  readonly samples: number;
  readonly maxRenderedRows: number;
  readonly elapsedMs: number;
}

/**
 * Lightweight, dependency-free benchmark for CI and manual renderer checks.
 * It measures range calculation rather than browser paint time, which keeps
 * the assertion useful on machines without Electron or a display.
 */
export function benchmarkVirtualList(rows = 5_000, samples = 1_000): VirtualListBenchmarkResult {
  const started = performance.now();
  let maxRenderedRows = 0;
  for (let index = 0; index < samples; index += 1) {
    const range = getVirtualRange({
      count: rows,
      rowHeight: 72,
      scrollTop: (index * 72 * 17) % (rows * 72),
      viewportHeight: 480,
    });
    maxRenderedRows = Math.max(maxRenderedRows, virtualRowCount(range));
  }
  return {
    rows,
    samples,
    maxRenderedRows,
    elapsedMs: performance.now() - started,
  };
}
