import { cn } from "./cn";
import { TIDY_TONE_CLASS, type TidyBadgeInfo } from "./run-state";

/** The one place that turns a tidy badge tone into colour classes. */
export function TidyBadge({ info, className }: { info: TidyBadgeInfo; className?: string }) {
  return (
    <span className={cn("rounded-full border border-line px-2 py-0.5 text-xs font-normal tracking-normal", TIDY_TONE_CLASS[info.tone], className)}>{info.text}</span>
  );
}
