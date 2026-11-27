import { useEffect, useState } from "react";
import { getJob, getJobs, holdSelected, retainJobs, type JobDetail, type JobSummary } from "./api";
import { cn } from "./cn";
import { exitInfo } from "./exit-info";
import { JobOutput } from "./JobOutput";
import { jobLabel, jobTidyBadge } from "./job-label";
import { TidyBadge } from "./TidyBadge";
import { LoadingBlock, LoadingStatus } from "./Loading";
import { startPoll } from "./poll";

const STATE = { running: "執行中", ended: "已結束", lost: "已結束（結束碼不明）" } as const;

export function JobsPage() {
  const [jobs, setJobs] = useState<JobSummary[]>();
  const [picked, setPicked] = useState<string>();
  // undefined = not loaded yet; null = request failed; a later failure keeps the last good detail
  const [detail, setDetail] = useState<JobDetail | null>();
  const [stale, setStale] = useState(false);
  // Resets only when the selected job changes. Block keys do not use the list index, and a failed list poll keeps the last jobs, so an open disclosure is not remounted.
  const [raw, setRaw] = useState(false);
  const [listDown, setListDown] = useState(false);
  // The summary of the selected job, so a newer page that drops it still renders the detail under the same row.
  const [pinned, setPinned] = useState<JobSummary>();

  useEffect(
    () =>
      startPoll(
        getJobs,
        (next) => {
          setListDown(next === null);
          setJobs((prev) => retainJobs(prev, next));
        },
        3000,
      ),
    [],
  );

  useEffect(() => {
    setDetail(undefined);
    setStale(false);
    setRaw(false);
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

  useEffect(() => {
    if (!picked) {
      setPinned(undefined);
      return;
    }
    const inList = jobs?.find((job) => job.id === picked);
    if (inList) {
      setPinned(inList);
      return;
    }
    if (detail?.id === picked) setPinned((prev) => (prev?.id === picked ? prev : detail));
  }, [jobs, picked, detail]);

  if (jobs === undefined) {
    return listDown ? <p className="text-pretty p-4 text-sm text-failed">無法取得任務清單，稍後會自動重試。</p> : <LoadingBlock label="正在讀取任務清單…" />;
  }

  const rows = holdSelected(jobs, picked, pinned);

  return (
    <article className="enter animate-in fade-in p-4 duration-200 sm:p-6">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">任務輸出</h1>
      <p className="text-pretty mt-2 text-sm">從網頁啟動的背景指令。它們獨立於這個頁面，關掉頁面也會繼續跑。</p>
      {listDown && <p className="mt-2 text-sm text-warn">清單更新失敗，顯示上次的結果。</p>}
      {rows.length === 0 ? (
        <p className="text-pretty mt-6 text-sm">還沒有從網頁啟動過的背景指令；若剛啟動過卻沒看到，可能是暫時無法取得清單，稍後會自動重試。</p>
      ) : (
        <ul className="mt-6 flex flex-col gap-2">
          {rows.map((j) => {
            const info = j.state === "ended" ? exitInfo(j.exit ?? null, false) : undefined;
            const label = jobLabel(j.argv);
            const tidy = jobTidyBadge(j);
            const open = picked === j.id;
            return (
              <li key={j.id} className="min-w-0">
                <button
                  type="button"
                  aria-pressed={open}
                  aria-expanded={open}
                  className={cn("panel flex min-h-11 w-full flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal", open && "border-ink/40")}
                  onClick={() => setPicked(open ? undefined : j.id)}
                >
                  <span className="font-mono">{j.command}</span>
                  {label.project && <span className="font-mono text-ink/70">{label.project}</span>}
                  {label.target && <span className="min-w-0 max-w-full truncate font-medium">{label.target}</span>}
                  {tidy && <TidyBadge info={tidy} />}
                  <span className="text-ink/60">{new Date(j.started_at).toLocaleString()}</span>
                  <span className={cn(j.state === "running" ? "text-signal" : info?.tone === "ok" ? "text-signal" : info?.tone === "warn" ? "text-warn" : j.state === "lost" ? "text-warn" : "text-failed")}>
                    {j.state === "ended" && info ? info.text : STATE[j.state]}
                  </span>
                </button>
                {open && <JobDetailSlot picked={j.id} detail={detail} stale={stale} raw={raw} onRaw={setRaw} />}
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}

function JobDetailSlot({ picked, detail, stale, raw, onRaw }: { picked: string; detail: JobDetail | null | undefined; stale: boolean; raw: boolean; onRaw: (raw: boolean) => void }) {
  if (detail === undefined || (detail !== null && detail.id !== picked)) {
    return (
      <div className="mt-2 rounded-lg border border-line bg-paper p-4">
        <LoadingStatus label="正在讀取輸出…" />
        <div className="mt-3 space-y-2" aria-hidden="true">
          <div className="h-3 w-full motion-safe:animate-pulse rounded bg-line" />
          <div className="h-3 w-5/6 motion-safe:animate-pulse rounded bg-line" />
          <div className="h-3 w-2/3 motion-safe:animate-pulse rounded bg-line" />
        </div>
      </div>
    );
  }
  if (detail === null) return <p className="text-pretty mt-2 text-sm text-failed">無法取得這個任務的輸出，稍後會自動重試。</p>;
  return (
    <div className="mt-2">
      <JobOutput job={detail} stale={stale} raw={raw} onRaw={onRaw} />
    </div>
  );
}
