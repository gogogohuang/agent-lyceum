import { useEffect, useState } from "react";
import { getJob, getJobs, type JobDetail, type JobSummary } from "./api";
import { cn } from "./cn";
import { exitInfo } from "./exit-info";
import { startPoll } from "./poll";

const STATE = { running: "執行中", ended: "已結束", lost: "已結束（結束碼不明）" } as const;

export function JobsPage() {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [picked, setPicked] = useState<string>();
  // undefined = not loaded yet; null = request failed; a later failure keeps the last good detail
  const [detail, setDetail] = useState<JobDetail | null>();
  const [stale, setStale] = useState(false);

  useEffect(() => startPoll(getJobs, setJobs, 3000), []);

  useEffect(() => {
    setDetail(undefined);
    setStale(false);
    if (!picked) return;
    return startPoll(
      () => getJob(picked),
      (d) => {
        if (d) {
          setDetail(d);
          setStale(false);
        } else {
          setDetail((prev) => prev ?? null);
          setStale(true);
        }
      },
      2000,
    );
  }, [picked]);

  return (
    <article className="enter animate-in fade-in p-4 duration-200 sm:p-6">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">任務輸出</h1>
      <p className="text-pretty mt-2 text-sm">從網頁啟動的背景指令。它們獨立於這個頁面，關掉頁面也會繼續跑。</p>
      {jobs.length === 0 ? (
        <p className="text-pretty mt-6 text-sm">還沒有從網頁啟動過的背景指令；若剛啟動過卻沒看到，可能是暫時無法取得清單，稍後會自動重試。</p>
      ) : (
        <ul className="mt-6 flex flex-col gap-2">
          {jobs.map((j) => {
            const info = j.state === "ended" ? exitInfo(j.exit ?? null, false) : undefined;
            return (
              <li key={j.id}>
                <button
                  type="button"
                  aria-pressed={picked === j.id}
                  className={cn("panel flex min-h-11 w-full flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal", picked === j.id && "border-ink/40")}
                  onClick={() => setPicked(picked === j.id ? undefined : j.id)}
                >
                  <span className="font-mono">{j.command}</span>
                  <span className="text-ink/60">{new Date(j.started_at).toLocaleString()}</span>
                  <span className={cn(j.state === "running" ? "text-signal" : info?.tone === "ok" ? "text-signal" : info?.tone === "warn" ? "text-warn" : j.state === "lost" ? "text-warn" : "text-failed")}>
                    {j.state === "ended" && info ? info.text : STATE[j.state]}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {picked && detail === undefined && <p className="mt-6 text-sm">正在讀取輸出…</p>}
      {picked && detail === null && <p className="text-pretty mt-6 text-sm text-failed">無法取得這個任務的輸出，稍後會自動重試。</p>}
      {detail && (
        <section aria-label="輸出" className="mt-6">
          <p className="eyebrow">{detail.argv.join(" ")}</p>
          {stale && <p className="mt-1 text-sm text-warn">更新失敗，稍後重試</p>}
          <pre className="mt-2 max-h-[60dvh] overflow-auto rounded-lg border border-line bg-paper p-3 font-mono text-xs whitespace-pre-wrap">{detail.tail || "（還沒有輸出）"}</pre>
        </section>
      )}
    </article>
  );
}
