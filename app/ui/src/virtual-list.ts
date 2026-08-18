export interface VirtualRange {
  readonly start: number;
  readonly end: number;
  readonly offsetTop: number;
  readonly totalHeight: number;
}

export interface VirtualRangeOptions {
  readonly count: number;
  readonly rowHeight: number;
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly overscan?: number;
}

/**
 * Calculate the small slice that belongs in the DOM. Keeping this pure makes
 * the 5,000-row guarantee testable without a browser or a React renderer.
 */
export function getVirtualRange({
  count,
  rowHeight,
  scrollTop,
  viewportHeight,
  overscan = 6,
}: VirtualRangeOptions): VirtualRange {
  const safeCount = Math.max(0, Math.floor(count));
  const safeRowHeight = Math.max(1, rowHeight);
  const safeViewportHeight = Math.max(0, viewportHeight);
  const safeScrollTop = Math.max(0, scrollTop);
  const firstVisible = Math.min(safeCount, Math.floor(safeScrollTop / safeRowHeight));
  const visibleRows = Math.max(1, Math.ceil(safeViewportHeight / safeRowHeight));
  const safeOverscan = Math.max(0, Math.floor(overscan));
  const start = Math.max(0, firstVisible - safeOverscan);
  const end = Math.min(safeCount, firstVisible + visibleRows + safeOverscan);
  return {
    start,
    end,
    offsetTop: start * safeRowHeight,
    totalHeight: safeCount * safeRowHeight,
  };
}

export function virtualRowCount(range: VirtualRange): number {
  return Math.max(0, range.end - range.start);
}
