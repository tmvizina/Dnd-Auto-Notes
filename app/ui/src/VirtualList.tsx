import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type UIEvent,
} from "react";
import { getVirtualRange } from "./virtual-list.js";

export interface VirtualListProps<T> {
  readonly items: readonly T[];
  readonly rowHeight: number;
  readonly renderRow: (item: T, index: number) => ReactNode;
  readonly getKey?: (item: T, index: number) => string | number;
  readonly empty?: ReactNode;
  readonly ariaLabel?: string;
  readonly className?: string;
}

const DEFAULT_VIEWPORT_HEIGHT = 480;

/** Fixed-row virtualization keeps the session timeline bounded in the DOM. */
export function VirtualList<T>({
  items,
  rowHeight,
  renderRow,
  getKey,
  empty = null,
  ariaLabel = "Virtualized list",
  className,
}: VirtualListProps<T>): ReactNode {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);

  const measure = useCallback(() => {
    const element = viewportRef.current;
    if (element !== null && element.clientHeight > 0) setViewportHeight(element.clientHeight);
  }, []);

  useLayoutEffect(() => {
    measure();
    const element = viewportRef.current;
    if (element === null || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    setScrollTop(event.currentTarget.scrollTop);
  };

  if (items.length === 0) return empty;

  const range = getVirtualRange({
    count: items.length,
    rowHeight,
    scrollTop,
    viewportHeight,
  });
  const rows: ReactNode[] = [];
  for (let index = range.start; index < range.end; index += 1) {
    const item = items[index];
    if (item === undefined) continue;
    const key = getKey?.(item, index) ?? index;
    const style: CSSProperties = {
      height: rowHeight,
      left: 0,
      position: "absolute",
      right: 0,
      top: index * rowHeight,
    };
    rows.push(
      <div className="virtual-list__row" key={key} style={style}>
        {renderRow(item, index)}
      </div>,
    );
  }

  return (
    <div
      aria-label={ariaLabel}
      aria-rowcount={items.length}
      className={className === undefined ? "virtual-list" : `virtual-list ${className}`}
      data-virtualized="true"
      onScroll={onScroll}
      ref={viewportRef}
      role="list"
      tabIndex={0}
    >
      <div
        className="virtual-list__content"
        style={{ height: range.totalHeight, position: "relative" }}
      >
        {rows}
      </div>
    </div>
  );
}
