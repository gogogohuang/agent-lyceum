import { Tooltip } from "@base-ui/react/tooltip";
import type { Agent, Run } from "../types";
import { cn } from "./cn";
import { clock, timeline, type LaneBar } from "./view";

export function Timeline({ run, agents, now }: { run?: Run; agents: Agent[]; now: number }) {
  const model = timeline(run, agents, now);
  return (
    <figure className="panel p-3 sm:p-4">
      <figcaption className="text-balance text-base font-semibold">喚醒時間軸</figcaption>
      {!model ? (
        <p className="text-pretty mt-3 text-sm">這個任務還沒有喚醒紀錄。</p>
      ) : (
        <Tooltip.Provider delay={0}>
          <div className="mt-3 space-y-1">
            {model.lanes.map((lane) => (
              <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[7rem_minmax(0,1fr)]" key={lane.agent}>
                <div className="truncate font-mono text-xs text-ink/80" title={lane.agent}>
                  {lane.agent}
                </div>
                <div className="relative h-7" role="group" aria-label={`${lane.agent} 的喚醒`}>
                  <div className="absolute inset-x-0 top-5 h-px bg-line" />
                  {lane.bars.map((bar, index) => (
                    <WakeBar key={`${bar.x}-${index}`} bar={bar} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-[5rem_minmax(0,1fr)] text-xs tabular-nums text-ink/60 sm:grid-cols-[7rem_minmax(0,1fr)]">
            <span />
            <span className="flex justify-between">
              <span>{clock(model.start)}</span>
              <span>{clock(model.end)}</span>
            </span>
          </div>
          <p className="text-pretty mt-2 text-sm text-ink/70">實心是已結束的喚醒，框線延伸到現在的是還在跑的。紅色是失敗。把游標放在色塊上看該輪的時間、token 與錯誤。</p>
        </Tooltip.Provider>
      )}
    </figure>
  );
}

function WakeBar({ bar }: { bar: LaneBar }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        type="button"
        aria-label={bar.title}
        className={cn(
          "absolute block min-h-0 min-w-0 cursor-pointer rounded-[3px] p-0",
          bar.live ? "top-1.5 h-4 border-2 border-working bg-transparent" : bar.ok ? "top-2 h-3 border-0 bg-signal/70" : "top-2 h-3 border-0 bg-failed",
        )}
        style={{ left: `${bar.x / 10}%`, width: `${bar.width / 10}%` }}
      />
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={8} className="z-50">
          <Tooltip.Popup className={cn("panel max-h-[min(12rem,var(--available-height,12rem))] max-w-xs overflow-y-auto px-3 py-2 text-sm wrap-break-word text-ink outline-none", bar.ok ? "border-line" : "border-failed/40")}>
            {bar.lines.map((line, index) => (
              <p key={index} className={cn("text-pretty leading-snug", index > 0 && "mt-1")}>
                {line}
              </p>
            ))}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
