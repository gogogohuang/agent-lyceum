import { useEffect, useState } from "react";
import { cn } from "./cn";

/** Show busy UI only after a short wait so near-instant work does not flash. */
export function useDeferredBusy(busy: boolean, delayMs = 160): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!busy) {
      setShown(false);
      return;
    }
    const id = window.setTimeout(() => setShown(true), delayMs);
    return () => window.clearTimeout(id);
  }, [busy, delayMs]);
  return shown;
}

/** Compact status line with a moving pulse — for inline / dialog waits. */
export function LoadingStatus({ label, className }: { label: string; className?: string }) {
  return (
    <p role="status" aria-live="polite" aria-busy="true" className={cn("flex min-h-11 items-center gap-2 text-sm text-ink/70", className)}>
      <span aria-hidden className="pulse-dot size-2 shrink-0 rounded-full bg-signal" />
      <span>{label}</span>
    </p>
  );
}

/** Skeleton panel that keeps layout feeling alive while content loads. */
export function LoadingBlock({ label, className }: { label: string; className?: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className={cn("enter animate-in fade-in p-4 duration-200 sm:p-6", className)}>
      <LoadingStatus label={label} />
      <div className="mt-4 space-y-3" aria-hidden="true">
        <div className="h-3 w-2/3 motion-safe:animate-pulse rounded bg-line" />
        <div className="h-3 w-full motion-safe:animate-pulse rounded bg-line" />
        <div className="h-3 w-5/6 motion-safe:animate-pulse rounded bg-line" />
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <div className="panel h-24 motion-safe:animate-pulse bg-paper" />
          <div className="panel h-24 motion-safe:animate-pulse bg-paper" />
        </div>
      </div>
    </div>
  );
}

/** Thin indeterminate bar across the content edge while a view transition is pending. */
export function LoadingBar({ label }: { label: string }) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="relative h-1 overflow-hidden bg-line">
      <span className="sr-only">{label}</span>
      <span aria-hidden className="loading-bar absolute inset-y-0 w-1/3 rounded-full bg-signal" />
    </div>
  );
}
