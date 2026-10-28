import type { Agent, Run } from "../types";
import { clock, timeline } from "./view";

export function Timeline({ run, agents, now }: { run?: Run; agents: Agent[]; now: number }) {
  const model = timeline(run, agents, now);
  return (
    <figure className="mt-10">
      <figcaption className="text-balance text-xl">喚醒時間軸</figcaption>
      {!model ? (
        <p className="text-pretty mt-3 text-sm">這個任務還沒有喚醒紀錄。</p>
      ) : (
        <>
          <div className="mt-3 space-y-1">
            {model.lanes.map((lane) => (
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2" key={lane.agent}>
                <div className="truncate text-xs" title={lane.agent}>
                  {lane.agent}
                </div>
                <svg viewBox="0 0 1000 28" preserveAspectRatio="none" className="h-7 w-full" role="img" aria-label={`${lane.agent} 的喚醒`}>
                  <line x1="0" x2="1000" y1="20" y2="20" className="stroke-line" />
                  {lane.bars.map((bar, index) => (
                    <rect
                      key={`${bar.x}-${index}`}
                      x={bar.x}
                      y={bar.live ? 6 : 8}
                      width={Math.max(bar.width, 4)}
                      height={bar.live ? 16 : 12}
                      rx="1"
                      className={bar.live ? "fill-none stroke-working" : bar.ok ? "fill-ink" : "fill-failed"}
                      strokeWidth={bar.live ? 8 : 0}
                    >
                      <title>{bar.title}</title>
                    </rect>
                  ))}
                </svg>
              </div>
            ))}
          </div>
          <div className="mt-1 grid grid-cols-[7rem_minmax(0,1fr)] text-xs tabular-nums text-ink/60">
            <span />
            <span className="flex justify-between">
              <span>{clock(model.start)}</span>
              <span>{clock(model.end)}</span>
            </span>
          </div>
          <p className="text-pretty mt-2 text-sm text-ink/70">實心是已結束的喚醒，框線延伸到現在的是還在跑的。紅色是失敗。把游標放在色塊上看該輪的時間、token 與錯誤。</p>
        </>
      )}
    </figure>
  );
}
