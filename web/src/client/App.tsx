import { Button } from "@base-ui/react/button";
import { useEffect, useState } from "react";
import type { QuotaReport, WatchFrame, WebEvent } from "../types";
import { cn } from "./cn";
import { ProjectView } from "./ProjectView";
import { headline, railText } from "./rail";
import { focusReport } from "./view";

type Live = "up" | "down";

export function App() {
  const [projects, setProjects] = useState<Map<string, WatchFrame>>(() => new Map());
  const [live, setLive] = useState<Live>("down");
  const [now, setNow] = useState(() => Date.now());
  const [hash, setHash] = useState(readHash);
  const [attempt, setAttempt] = useState(0);
  const [quota, setQuota] = useState<QuotaReport[] | undefined>(undefined);

  useEffect(() => {
    const source = new EventSource("/events");
    source.onopen = () => setLive("up");
    source.onerror = () => setLive("down");
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as WebEvent;
      if (event.type === "quota") {
        setQuota(event.reports);
        return;
      }
      if (event.type === "snapshot" && event.quota) setQuota(event.quota);
      setProjects((prev) => apply(prev, event));
    };
    return () => source.close();
  }, [attempt]);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    const onHash = () => setHash(readHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const names = [...projects.keys()].sort((a, b) => rank(projects.get(a)) - rank(projects.get(b)) || a.localeCompare(b));
  const selected = hash.project && projects.has(hash.project) ? hash.project : names[0];
  const frame = selected ? projects.get(selected) : undefined;

  return (
    <div className="grid h-dvh grid-cols-1 bg-wall md:grid-cols-[15rem_minmax(0,1fr)]">
      <nav aria-label="已註冊專案" className="inset-safe sticky top-0 z-10 flex gap-2 overflow-x-auto border-b border-line bg-wall p-3 md:h-dvh md:flex-col md:overflow-y-auto md:border-r md:border-b-0">
        <p className="hidden px-2 pt-2 text-sm text-ink/60 md:block">專案</p>
        {names.length === 0 ? (
          <p className="text-pretty px-2 text-sm">{live === "up" ? "還沒有已註冊的專案。" : "正在連上本機狀態…"}</p>
        ) : (
          names.map((name) => {
            const item = projects.get(name);
            const on = name === selected;
            const running = item ? focusReport(item)?.run?.state === "running" : false;
            return (
              <Button
                key={name}
                type="button"
                className={cn(
                  "min-w-36 shrink-0 border-l-2 px-2 py-2 text-left md:min-w-0",
                  on && running && "border-signal bg-paper",
                  on && !running && "border-ink bg-paper",
                  !on && "border-transparent hover:bg-paper/60",
                )}
                onClick={() => select(name)}
              >
                <span className="block truncate text-sm">{name}</span>
                <span className={cn("block truncate text-xs tabular-nums", running ? "text-signal" : "text-ink/60")}>{item ? railText(item) : ""}</span>
              </Button>
            );
          })
        )}
        <div className="mt-auto hidden px-2 pb-2 md:block">
          {live === "up" ? (
            <p className="text-xs text-ink/60">即時更新</p>
          ) : (
            <Button type="button" className="text-sm underline" onClick={() => setAttempt((n) => n + 1)}>
              重新連線
            </Button>
          )}
        </div>
      </nav>
      <main className="min-h-0 overflow-y-auto bg-paper">
        {(live === "up" || (quota && quota.length > 0)) && <Allowance reports={quota ?? []} onReports={setQuota} />}
        {frame && selected ? (
          <ProjectView name={selected} frame={frame} runId={hash.project === selected ? hash.run : undefined} now={now} onRun={(id) => select(selected, id)} />
        ) : (
          <article className="enter animate-in fade-in p-6 duration-200">
            <h1 className="text-balance text-4xl font-bold leading-tight">{headline(live, names.length)}</h1>
            {live === "up" && names.length === 0 && <p className="text-pretty mt-3 text-sm">在終端執行 agent-lyceum project add 註冊一個專案。</p>}
            {live === "down" && (
              <Button type="button" className="mt-4 text-sm underline" onClick={() => setAttempt((n) => n + 1)}>
                重新連線
              </Button>
            )}
          </article>
        )}
      </main>
    </div>
  );
}

function select(project: string, run?: string): void {
  const next = run ? `${encodeURIComponent(project)}/${encodeURIComponent(run)}` : encodeURIComponent(project);
  location.hash = next;
}

function readHash(): { project?: string; run?: string } {
  try {
    const raw = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (!raw) return {};
    const slash = raw.indexOf("/");
    if (slash === -1) return { project: raw };
    return { project: raw.slice(0, slash), run: raw.slice(slash + 1) };
  } catch {
    return {};
  }
}

function Allowance({ reports, onReports }: { reports: QuotaReport[]; onReports: (reports: QuotaReport[]) => void }) {
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

  return (
    <div className="sticky top-0 z-10 border-b border-line bg-wall px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        {reports.map((report) => (
          <p key={report.runtime} className="text-sm">
            <span>{report.runtime}</span>
            {report.error ? (
              <span className="text-pretty ml-3 text-failed">{report.error}</span>
            ) : report.windows.length === 0 ? (
              <span className="ml-3 text-ink/60">沒有讀到額度</span>
            ) : (
              report.windows.map((window) => (
                <span key={window.label} className="ml-3 tabular-nums">
                  {window.label}剩餘 {percent(window.remaining_percent)}%
                  <span className="text-ink/60"> 重設 {window.resets}</span>
                </span>
              ))
            )}
          </p>
        ))}
        <Button type="button" disabled={pending} className="text-sm underline disabled:opacity-60" onClick={refresh}>
          {pending ? "正在取得" : "重新取得"}
        </Button>
        {error && <span className="text-pretty text-sm text-failed">{error}</span>}
      </div>
    </div>
  );
}

function percent(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function apply(prev: Map<string, WatchFrame>, event: WebEvent): Map<string, WatchFrame> {
  if (event.type === "quota") return prev;
  if (event.type === "snapshot") {
    return new Map(event.projects.map((project) => [project.name, project.frame]));
  }
  const next = new Map(prev);
  if (event.type === "removed") next.delete(event.name);
  else next.set(event.name, event.frame);
  return next;
}

function rank(frame: WatchFrame | undefined): number {
  if (!frame || frame.error) return 3;
  const state = focusReport(frame)?.run?.state;
  if (state === "running") return 0;
  if (state) return 1;
  return 2;
}
