import { Button } from "@base-ui/react/button";
import { useEffect, useState } from "react";
import type { QuotaReport, WatchFrame, WebEvent } from "../types";
import { Allowance } from "./Allowance";
import { cn } from "./cn";
import { DecisionsPage } from "./DecisionsPage";
import { JobsPage } from "./JobsPage";
import { ProjectView } from "./ProjectView";
import { headline, railText } from "./rail";
import { ToolsPage } from "./ToolsPage";
import { focusReport, latestRunMs } from "./view";

type Live = "up" | "down";

export function App() {
  const [projects, setProjects] = useState<Map<string, WatchFrame>>(() => new Map());
  const [live, setLive] = useState<Live>("down");
  const [now, setNow] = useState(() => Date.now());
  const [hash, setHash] = useState(readHash);
  const [attempt, setAttempt] = useState(0);
  const [quota, setQuota] = useState<QuotaReport[] | undefined>(undefined);
  const [hidden, setHidden] = useState<Set<string>>(loadHidden);
  const [showHidden, setShowHidden] = useState(false);

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

  const names = [...projects.keys()].sort((a, b) => cmpRecent(latestRunMs(projects.get(a)), latestRunMs(projects.get(b))) || a.localeCompare(b));
  const shown = showHidden ? names : names.filter((name) => !hidden.has(name));
  const hiddenCount = names.filter((name) => hidden.has(name)).length;
  const selected = hash.project && projects.has(hash.project) ? hash.project : (shown[0] ?? names[0]);
  const toggleHidden = (name: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      saveHidden(next);
      return next;
    });
  const frame = selected ? projects.get(selected) : undefined;

  return (
    <div className="grid h-dvh grid-cols-1 grid-rows-[auto_minmax(0,1fr)] bg-wall md:grid-cols-[14rem_minmax(0,1fr)] md:grid-rows-1 xl:grid-cols-[16rem_minmax(0,1fr)]">
      <nav aria-label="已註冊專案" className="inset-safe z-20 flex items-center gap-2 overflow-x-auto border-b border-line bg-paper p-3 md:sticky md:top-0 md:h-dvh md:flex-col md:items-stretch md:overflow-y-auto md:border-r md:border-b-0">
        <p className="eyebrow hidden px-2 pt-2 pb-1 md:block">專案</p>
        {shown.length === 0 ? (
          <p className="text-pretty px-2 text-sm">{names.length > 0 ? "專案都已隱藏。" : live === "up" ? "還沒有已註冊的專案。" : "正在連上本機狀態…"}</p>
        ) : (
          shown.map((name) => {
            const item = projects.get(name);
            const on = !hash.view && name === selected;
            const running = item ? focusReport(item)?.run?.state === "running" : false;
            const isHidden = hidden.has(name);
            return (
              <div key={name} className={cn("group relative shrink-0", isHidden && "opacity-60")}>
              <Button
                type="button"
                className={cn(
                  "min-h-11 w-full min-w-36 rounded-lg border px-3 py-2 pr-9 text-left md:min-w-0",
                  on ? "border-line bg-wall" : "border-transparent hover:bg-wall/70",
                )}
                onClick={() => select(name)}
              >
                <span className="flex items-center gap-2 truncate text-sm font-medium">
                  <span aria-hidden className={cn("size-2 shrink-0 rounded-full", running ? "pulse-dot bg-signal" : item?.error ? "bg-failed" : "bg-ink/25")} />
                  <span className="truncate">{name}</span>
                </span>
                <span className={cn("mt-0.5 block truncate pl-4 font-mono text-xs tabular-nums", running ? "text-signal" : "text-ink/60")}>{item ? railText(item) : ""}</span>
              </Button>
              <Button
                type="button"
                aria-label={isHidden ? `顯示 ${name}` : `隱藏 ${name}`}
                title={isHidden ? "取消隱藏" : "隱藏"}
                className="absolute top-1 right-1 inline-flex size-7 items-center justify-center rounded-md text-xs text-ink/50 hover:bg-wall hover:text-ink focus-visible:outline-2 focus-visible:outline-signal md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                onClick={() => toggleHidden(name)}
              >
                <EyeIcon off={!isHidden} />
              </Button>
              </div>
            );
          })
        )}
        {hiddenCount > 0 && (
          <Button type="button" className="min-h-9 shrink-0 rounded-lg px-3 text-left text-xs text-ink/60 underline" onClick={() => setShowHidden((v) => !v)}>
            {showHidden ? "收起已隱藏" : `顯示已隱藏 (${hiddenCount})`}
          </Button>
        )}
        <div className="flex items-center gap-2 md:mt-4 md:flex-col md:items-stretch md:border-t md:border-line md:pt-3">
          {([["decisions", "決策"], ["tools", "工具"], ["jobs", "任務輸出"]] as const).map(([view, label]) => (
            <a
              key={view}
              href={`#!${view}`}
              aria-current={hash.view === view ? "page" : undefined}
              className={cn(
                "inline-flex min-h-11 min-w-24 shrink-0 items-center rounded-lg border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
                hash.view === view ? "border-line bg-wall" : "border-transparent hover:bg-wall/70",
              )}
            >
              {label}
            </a>
          ))}
        </div>
        {live === "down" && (
          <Button type="button" className="min-h-11 shrink-0 rounded-lg border border-line px-3 text-sm underline md:hidden" onClick={() => setAttempt((n) => n + 1)}>
            重新連線
          </Button>
        )}
        <div className="mt-auto hidden px-2 pb-2 md:block">
          {live === "up" ? (
            <p className="flex items-center gap-2 text-xs text-ink/60"><span aria-hidden className="size-1.5 rounded-full bg-signal" />即時更新</p>
          ) : (
            <Button type="button" className="text-sm underline" onClick={() => setAttempt((n) => n + 1)}>
              重新連線
            </Button>
          )}
        </div>
      </nav>
      <main className="min-h-0 overflow-y-auto bg-wall">
        {(live === "up" || (quota && quota.length > 0)) && <Allowance reports={quota ?? []} onReports={setQuota} />}
        {hash.view === "decisions" ? (
          <DecisionsPage />
        ) : hash.view === "tools" ? (
          <ToolsPage projects={names} />
        ) : hash.view === "jobs" ? (
          <JobsPage />
        ) : frame && selected ? (
          <ProjectView name={selected} frame={frame} runId={hash.project === selected ? hash.run : undefined} now={now} onRun={(id) => select(selected, id)} />
        ) : (
          <article className="enter animate-in fade-in p-4 duration-200 sm:p-6">
            <h1 className="text-balance text-2xl font-semibold tracking-tight">{headline(live, names.length)}</h1>
            {live === "up" && names.length === 0 && <p className="text-pretty mt-3 text-sm">在終端執行 agent-lyceum project add 註冊一個專案。</p>}
            {live === "down" && (
              <Button type="button" className="mt-4 min-h-11 rounded-md border border-line bg-paper px-4 py-1.5 text-sm hover:bg-wall" onClick={() => setAttempt((n) => n + 1)}>
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

function readHash(): { project?: string; run?: string; view?: "tools" | "jobs" | "decisions" } {
  try {
    const raw = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (!raw) return {};
    if (raw === "!tools" || raw === "!jobs" || raw === "!decisions") return { view: raw.slice(1) as "tools" | "jobs" | "decisions" };
    const slash = raw.indexOf("/");
    if (slash === -1) return { project: raw };
    return { project: raw.slice(0, slash), run: raw.slice(slash + 1) };
  } catch {
    return {};
  }
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

/** Newest run first; projects that never ran (-Infinity) go last. */
function cmpRecent(a: number, b: number): number {
  if (a === b) return 0;
  return a > b ? -1 : 1;
}

const HIDDEN_KEY = "lyceum.hiddenProjects";

function loadHidden(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function saveHidden(set: Set<string>): void {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify([...set]));
  } catch {
    // storage unavailable (private mode): hide still works for this session
  }
}

/** Eye = show again; slashed eye = hide. Deliberately not an "x", which reads as close/delete. */
function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}
