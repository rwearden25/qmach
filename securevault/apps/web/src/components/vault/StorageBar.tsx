import React from 'react';

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}

/**
 * Returns a Tailwind gradient class based on percentage used.
 * Green (0-60%) → Yellow (60-80%) → Red (80-100%)
 */
function getBarColor(pct: number): string {
  if (pct >= 80) return 'from-warning to-danger';
  if (pct >= 60) return 'from-primary to-warning';
  return 'from-primary to-primary';
}

function getTextColor(pct: number): string {
  if (pct >= 80) return 'text-danger';
  if (pct >= 60) return 'text-warning';
  return 'text-primary';
}

/* ------------------------------------------------------------------ */
/* Props                                                                */
/* ------------------------------------------------------------------ */

export interface StorageBarProps {
  used: number;   // bytes
  limit: number;  // bytes
  /** compact = single-line for header; expanded = larger with more info */
  variant?: 'compact' | 'expanded';
  className?: string;
}

/* ------------------------------------------------------------------ */
/* Component                                                            */
/* ------------------------------------------------------------------ */

export function StorageBar({
  used,
  limit,
  variant = 'compact',
  className = '',
}: StorageBarProps) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const barColor = getBarColor(pct);
  const textColor = getTextColor(pct);

  if (variant === 'compact') {
    return (
      <div
        className={`flex items-center gap-2 min-w-0 ${className}`}
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Storage: ${formatBytes(used)} of ${formatBytes(limit)} used`}
      >
        {/* Bar track */}
        <div className="flex-1 h-1.5 rounded-full bg-[#1F1F23] overflow-hidden min-w-[80px]">
          <div
            className={`h-full rounded-full bg-gradient-to-r ${barColor} transition-all duration-500`}
            style={{ width: `${pct}%` }}
          />
        </div>
        {/* Label */}
        <span className="text-xs text-[#71717A] whitespace-nowrap shrink-0">
          <span className={`font-medium ${textColor}`}>{formatBytes(used)}</span>
          {' / '}
          {formatBytes(limit)}
        </span>
      </div>
    );
  }

  /* ---- expanded variant ---- */
  return (
    <div
      className={`space-y-3 ${className}`}
      role="meter"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Storage: ${formatBytes(used)} of ${formatBytes(limit)} used`}
    >
      {/* Header row */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-[#FAFAFA]">Storage Used</span>
        <span className={`text-sm font-semibold ${textColor}`}>{pct}%</span>
      </div>

      {/* Bar track */}
      <div className="h-2.5 rounded-full bg-[#1F1F23] overflow-hidden">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${barColor} transition-all duration-500`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Detail row */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-[#71717A]">
          <span className={`font-semibold ${textColor}`}>{formatBytes(used)}</span>
          {' used'}
        </span>
        <span className="text-[#71717A]">
          {formatBytes(limit - used)} free of{' '}
          <span className="text-[#FAFAFA] font-medium">{formatBytes(limit)}</span>
        </span>
      </div>

      {/* Warning when over 80% */}
      {pct >= 80 && (
        <p className="text-xs text-warning bg-warning/10 border border-warning/20 rounded-input px-3 py-2">
          {pct >= 95
            ? 'Storage almost full. Delete files or upgrade your plan.'
            : 'Storage usage is high. Consider freeing up space.'}
        </p>
      )}
    </div>
  );
}

export default StorageBar;
