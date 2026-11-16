import { Button } from "@base-ui/react/button";
import { useState } from "react";
import type { QuotaReport, QuotaWindow } from "../types";
import { allowanceTone, orderReports, runtimeName, wholePercent } from "./allowance-view";
import { cn } from "./cn";

const TONE_BAR = { ok: "bg-signal", mid: "bg-warn", low: "bg-failed" } as const;
const TONE_TEXT = { ok: "text-ink", mid: "text-warn", low: "text-failed" } as const;

/** Remaining Claude / Codex allowance, laid out like slack-dispatcher's LimitsBar: one column per runtime, a meter per window. */
export function Allowance({ reports, onReports }: { reports: QuotaReport[]; onReports: (reports: QuotaReport[]) => void }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = () => {
    setPending(true);
    setError(undefined);
    void fetch("/quota", { method: "POST" })
      .then(async (response) => {
        if (!response.ok) throw new Error("重新取得失敗");
        onReports((await response.json()) as QuotaReport[]);
      })
      .catch(() => setError("重新取得失敗"))
      .finally(() => setPending(false));
  };

  const ordered = orderReports(reports);

  return (
    <section aria-label="剩餘額度" className="border-b border-line bg-paper">
      <div className="flex items-center justify-between gap-3 px-3 pt-2 sm:px-4">
        <h2 className="eyebrow">剩餘額度</h2>
        <div className="flex items-center gap-3">
          {error && <span role="alert" className="text-pretty text-sm text-failed">{error}</span>}
          <Button type="button" disabled={pending} className="min-h-11 rounded-md border border-line px-3 py-1 text-xs hover:bg-wall disabled:opacity-60 sm:min-h-8" onClick={refresh}>
            {pending ? "正在取得" : "重新取得"}
          </Button>
        </div>
      </div>
      {ordered.length === 0 ? (
        <div className="px-3 pt-1 pb-3 sm:px-4">
          <div aria-hidden className="h-8 w-1/2 rounded-md bg-ink/10 motion-safe:animate-pulse" />
        </div>
      ) : (
        <div className={cn("grid", ordered.length > 1 && "md:grid-cols-2 md:divide-x md:divide-line")}>
          {ordered.map((report, i) => (
            <div key={report.runtime} className={cn(i > 0 && "border-t border-line md:border-t-0")}>
              <RuntimeBlock report={report} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RuntimeBlock({ report }: { report: QuotaReport }) {
  const name = runtimeName(report.runtime);
  return (
    <div className="min-w-0 px-3 py-3 sm:px-4">
      <h3 className="text-sm text-ink/60">{`${name} 剩餘額度`}</h3>
      {report.error ? (
        <p className="text-pretty mt-2 text-sm text-failed">{report.error}</p>
      ) : report.windows.length === 0 ? (
        <p className="text-pretty mt-2 text-sm text-ink/60">沒有讀到額度</p>
      ) : (
        <div className="mt-2 space-y-3">
          {report.windows.map((window) => (
            <WindowRow key={window.label} runtime={name} window={window} />
          ))}
        </div>
      )}
    </div>
  );
}

function WindowRow({ runtime, window: win }: { runtime: string; window: QuotaWindow }) {
  const remaining = wholePercent(win.remaining_percent);
  const tone = allowanceTone(win.remaining_percent);
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="w-16 shrink-0 text-sm text-ink/60">{win.label}</span>
        <span className={cn("w-14 shrink-0 font-mono text-xl font-medium tabular-nums", TONE_TEXT[tone])}>{`${remaining}%`}</span>
        <div
          role="meter"
          aria-label={`${runtime} ${win.label} 剩餘額度`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={remaining}
          aria-valuetext={`剩餘 ${remaining}%`}
          className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-ink/10"
        >
          <div className={cn("h-full rounded-full motion-safe:transition-[width] motion-safe:duration-300", TONE_BAR[tone])} style={{ width: `${remaining}%` }} />
        </div>
        {tone === "low" && <span className="shrink-0 text-sm text-failed">快用完</span>}
      </div>
      <p className="mt-0.5 pl-[4.75rem] text-sm tabular-nums text-ink/60">{`重設 ${win.resets}`}</p>
    </div>
  );
}
