import React from 'react';

/* ------------------------------------------------------------------ */
/* Base Skeleton                                                        */
/* ------------------------------------------------------------------ */

interface SkeletonBaseProps {
  className?: string;
}

/* ------------------------------------------------------------------ */
/* SkeletonLine — animated pulsing bar                                  */
/* ------------------------------------------------------------------ */

export interface SkeletonLineProps extends SkeletonBaseProps {
  /** Tailwind width class, e.g. "w-3/4" or "w-40". Defaults to "w-full". */
  width?: string;
  /** Tailwind height class, e.g. "h-4". Defaults to "h-3.5". */
  height?: string;
}

export function SkeletonLine({
  width = 'w-full',
  height = 'h-3.5',
  className = '',
}: SkeletonLineProps) {
  return (
    <div
      role="presentation"
      aria-hidden="true"
      className={[
        'rounded-full skeleton animate-pulse',
        width,
        height,
        className,
      ].join(' ')}
    />
  );
}

/* ------------------------------------------------------------------ */
/* SkeletonCard — card-shaped skeleton for file grid                   */
/* ------------------------------------------------------------------ */

export interface SkeletonCardProps extends SkeletonBaseProps {
  /** Show a thumbnail area at the top. Defaults to true. */
  showThumbnail?: boolean;
}

export function SkeletonCard({
  showThumbnail = true,
  className = '',
}: SkeletonCardProps) {
  return (
    <div
      role="presentation"
      aria-hidden="true"
      className={[
        'flex flex-col gap-3 p-4 rounded-card border border-[#1F1F23] bg-[#141416]',
        'animate-pulse',
        className,
      ].join(' ')}
    >
      {/* Thumbnail placeholder */}
      {showThumbnail && (
        <div className="w-full h-32 rounded-input skeleton" />
      )}

      {/* File name */}
      <SkeletonLine width="w-3/4" height="h-4" />

      {/* File meta row */}
      <div className="flex items-center gap-2">
        <SkeletonLine width="w-16" height="h-3" />
        <SkeletonLine width="w-12" height="h-3" />
      </div>

      {/* Action row */}
      <div className="flex items-center gap-2 mt-1">
        <SkeletonLine width="w-20" height="h-8" className="rounded-full" />
        <SkeletonLine width="w-8" height="h-8" className="rounded-full" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SkeletonCardGrid — grid of SkeletonCards                            */
/* ------------------------------------------------------------------ */

export interface SkeletonCardGridProps extends SkeletonBaseProps {
  count?: number;
}

export function SkeletonCardGrid({ count = 6, className = '' }: SkeletonCardGridProps) {
  return (
    <div
      role="status"
      aria-label="Loading files…"
      className={[
        'grid grid-cols-1 tablet:grid-cols-2 desktop:grid-cols-3 gap-4',
        className,
      ].join(' ')}
    >
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SkeletonTable — table row skeletons for file list                   */
/* ------------------------------------------------------------------ */

export interface SkeletonTableProps extends SkeletonBaseProps {
  rows?: number;
  columns?: number;
}

export function SkeletonTable({
  rows = 5,
  columns = 4,
  className = '',
}: SkeletonTableProps) {
  return (
    <div
      role="status"
      aria-label="Loading table…"
      className={['w-full animate-pulse', className].join(' ')}
    >
      {/* Header row */}
      <div className="flex items-center gap-4 px-4 py-3 border-b border-[#1F1F23]">
        {Array.from({ length: columns }).map((_, i) => (
          <SkeletonLine
            key={i}
            width={i === 0 ? 'w-1/3' : i === columns - 1 ? 'w-16' : 'w-1/5'}
            height="h-3"
          />
        ))}
      </div>

      {/* Data rows */}
      {Array.from({ length: rows }).map((_, rowIdx) => (
        <div
          key={rowIdx}
          className="flex items-center gap-4 px-4 py-4 border-b border-[#1F1F23]"
        >
          {/* Icon placeholder on first col */}
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <div className="w-8 h-8 rounded-input skeleton shrink-0" />
            <div className="flex flex-col gap-1.5 flex-1 min-w-0">
              <SkeletonLine width="w-3/5" height="h-3.5" />
              <SkeletonLine width="w-2/5" height="h-2.5" />
            </div>
          </div>

          {Array.from({ length: columns - 1 }).map((_, colIdx) => (
            <SkeletonLine
              key={colIdx}
              width={colIdx === columns - 2 ? 'w-16' : 'w-1/6'}
              height="h-3"
            />
          ))}
        </div>
      ))}

      <span className="sr-only">Loading…</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* SkeletonText — paragraph block of lines                             */
/* ------------------------------------------------------------------ */

export interface SkeletonTextProps extends SkeletonBaseProps {
  lines?: number;
}

export function SkeletonText({ lines = 3, className = '' }: SkeletonTextProps) {
  const widths = ['w-full', 'w-5/6', 'w-3/4', 'w-full', 'w-2/3'];
  return (
    <div
      role="presentation"
      aria-hidden="true"
      className={['flex flex-col gap-2 animate-pulse', className].join(' ')}
    >
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonLine key={i} width={widths[i % widths.length]} height="h-3.5" />
      ))}
    </div>
  );
}

export default {
  Line: SkeletonLine,
  Card: SkeletonCard,
  CardGrid: SkeletonCardGrid,
  Table: SkeletonTable,
  Text: SkeletonText,
};
