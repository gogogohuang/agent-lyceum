import { Button } from "@base-ui/react/button";
import { Collapsible } from "@base-ui/react/collapsible";
import type { Run, StatusReport, WatchFrame } from "../types";
import { AgentTree } from "./AgentTree";
import { cn } from "./cn";
import { Timeline } from "./Timeline";
import { TokenChart } from "./TokenChart";
import { MailBody } from "./MailBody";
import { readableError, resultRows, splitNote } from "./prose";
import { ProgressSummary } from "./ProgressSummary";
import { cacheText, focusReport, openReports, progress, roundsLabel, runElapsed, runLabel, tokenText, workingAgents } from "./view";

export function ProjectView({
  name,
  frame,
  runId,
  now,
  onRun,
}: {
  name: string;
  frame: WatchFrame;
  runId?: string;
  now: number;
  onRun: (id: string) => void;
}) {
  if (frame.error) {
    return (
      <article className="enter animate-in fade-in p-6 duration-200">
        <h1 className="text-balance text-4xl font-bold leading-tight">{name}</h1>
        <p className="text-pretty mt-3 text-sm text-failed">{frame.error}</p>
        <p className="text-pretty mt-2 text-sm">在終端執行 agent-lyceum status -p {name} 看這個專案。</p>
      </article>
    );
  }
  const reports = openReports(frame);
  const current = reports.find((report) => report.run?.run_id === runId) ?? focusReport(frame);
  const run = current?.run;
  const agents = current?.agents ?? frame.report?.agents ?? [];
  const working = workingAgents(agents, run);
  return (
    <div className="enter animate-in fade-in grid gap-10 p-4 duration-200 lg:grid-cols-[minmax(0,1fr)_18rem] lg:p-8">
      <div className="min-w-0">
        <header>
          <p className="text-sm text-ink/60">{name}</p>
          {run ? (
            <RunHeader name={name} run={run} now={now} />
          ) : (
            <>
              <h1 className="text-balance mt-2 text-4xl font-bold leading-tight">還沒有任務</h1>
              <p className="text-pretty mt-3 text-sm">註冊的 agent 列在下面。</p>
            </>
          )}
        </header>
        {run?.ask && run.ask.unanswered > 0 && (
          <p className="text-pretty mt-4 border-l-2 border-ink/60 px-3 py-1 text-sm">
            等待回答 {run.ask.unanswered}/{run.ask.total}。檔案在 {run.ask.path}
          </p>
        )}
        {run?.failure && (
          <div className="mt-4 border-l-2 border-failed pl-3">
            <p className="text-sm text-failed">
              {run.failure.agent} 連續失敗 {run.failure.attempts} 次
            </p>
            {run.failure.error && <p className="text-pretty mt-1 max-w-xl text-sm leading-relaxed text-failed">{readableError(run.failure.error)}</p>}
          </div>
        )}
        {working.length > 0 && <AgentTree agents={agents} run={run} now={now} />}
        <Timeline run={run} agents={agents} now={now} />
        {working.length === 0 && <AgentTree agents={agents} run={run} now={now} />}
        <TokenChart run={run} />
        {run && <Facts report={current} />}
      </div>
      <History reports={reports} currentId={run?.run_id} onRun={onRun} />
    </div>
  );
}

function RunHeader({ name, run, now }: { name: string; run: Run; now: number }) {
  const task = run.task_summary || run.name || run.run_id;
  const cache = cacheText(run.cache_read_tokens, run.cache_write_tokens);
  const gone = run.live === false && run.state === "running";
  return (
    <>
      <h1 className="mt-2 max-w-3xl text-balance text-4xl font-bold leading-tight wrap-break-word md:text-5xl">{task}</h1>
      <div className="mt-6 flex max-w-3xl flex-wrap items-end gap-x-8 gap-y-3">
        <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
          <div>
            <dt className="text-sm text-ink/60">狀態</dt>
            <dd className={cn("mt-1 text-lg tabular-nums", stateClass(run))}>{runLabel(run)}</dd>
            {gone && <p className="text-pretty mt-1 text-sm text-failed">程序已不存在</p>}
          </div>
          <Cell label="輪次" value={`第 ${roundsLabel(run.rounds, run.max_rounds)} 輪`} />
          <Cell label="token" value={tokenText(run.output_tokens)} />
          <Cell label="已經過" value={runElapsed(run, now)} />
          <Cell label="進度" value={progress(run)} />
        </dl>
        <ProgressSummary key={`${name}/${run.run_id}`} project={name} runId={run.run_id} />
      </div>
      {cache && <p className="mt-4 text-lg tabular-nums">{cache}</p>}
      {run.current_step && <p className="text-pretty mt-4 max-w-xl text-sm">目前 {run.current_step}</p>}
    </>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-sm text-ink/60">{label}</dt>
      <dd className="mt-1 text-lg tabular-nums">{value}</dd>
    </div>
  );
}

function History({ reports, currentId, onRun }: { reports: StatusReport[]; currentId?: string; onRun: (id: string) => void }) {
  return (
    <aside className="lg:sticky lg:top-20 lg:max-h-[calc(100dvh-5rem)] lg:overflow-y-auto">
      <h2 className="text-balance text-lg">較早班次</h2>
      {reports.length === 0 ? (
        <p className="text-pretty mt-3 text-sm">這個專案還沒有任務。</p>
      ) : (
        <div className="mt-3">
          {reports.map((report) => {
            const run = report.run;
            if (!run) return null;
            const selected = run.run_id === currentId;
            return (
              <Button
                key={run.run_id}
                type="button"
                aria-current={selected ? "true" : undefined}
                className={cn(
                  "block w-full border-t border-line py-3 text-left",
                  selected && "border-l-2 pl-3",
                  selected && (run.state === "running" ? "border-l-signal" : "border-l-ink"),
                )}
                onClick={() => onRun(run.run_id)}
              >
                <span className="flex items-baseline justify-between gap-3 text-sm tabular-nums">
                  <span className="text-ink/70">{when(run.started_at)}</span>
                  <span className={stateClass(run)}>{runLabel(run)}</span>
                </span>
                <span className={cn("text-pretty mt-1 block", selected && "font-medium")}>{run.task_summary || run.name || run.run_id}</span>
              </Button>
            );
          })}
        </div>
      )}
    </aside>
  );
}

function Facts({ report }: { report: StatusReport | undefined }) {
  const run = report?.run;
  if (!run) return null;
  const steps = run.steps ?? [];
  return (
    <section className="mt-10">
      <h2 className="text-balance text-xl">這次任務</h2>
      {steps.length > 0 && (
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
          {steps.map((step) => (
            <li key={step.text} className={cn("text-pretty", step.done && "text-ink/50 line-through")}>
              {step.text}
            </li>
          ))}
        </ol>
      )}
      {(run.queue ?? []).length > 0 && (
        <div className="mt-6">
          <h3 className="text-balance text-sm">佇列</h3>
          {(run.queue ?? []).map((mail, index) => (
            <div key={`${index}-${mail.agent}-${mail.subject}`}>
              <p className="mt-4 text-sm text-ink/60">{mail.agent}</p>
              <MailBody mail={mail} />
            </div>
          ))}
        </div>
      )}
      {(run.blocked_integrations ?? []).length > 0 && (
        <div className="mt-6 max-w-xl">
          <h3 className="text-balance text-sm">受阻的整合</h3>
          {(run.blocked_integrations ?? []).map((item) => (
            <div key={`${item.agent}-${item.branch}`} className="mt-3">
              <p className="text-sm">
                {item.agent} <span className="text-ink/60">{item.branch}</span>
              </p>
              <p className="text-pretty mt-1 text-sm leading-relaxed">{item.reason}</p>
            </div>
          ))}
        </div>
      )}
      {(run.notes ?? []).length > 0 && (
        <div className="mt-6 max-w-xl">
          <h3 className="text-balance text-sm">備註</h3>
          {(run.notes ?? []).map((note, index) => (
            <Note key={`${index}-${note.slice(0, 24)}`} text={note} />
          ))}
        </div>
      )}
      {(report?.memory_advice ?? []).length > 0 && (
        <div className="mt-6 max-w-xl">
          <h3 className="text-balance text-sm">記憶建議</h3>
          {(report?.memory_advice ?? []).map((item) => (
            <Advice key={item} text={item} />
          ))}
        </div>
      )}
      {(run.result_head ?? []).length > 0 && <Result lines={run.result_head ?? []} />}
    </section>
  );
}

function Note({ text }: { text: string }) {
  const { head, body } = splitNote(text);
  const short = readableError(body);
  const more = body.length > short.length + 40;
  return (
    <Collapsible.Root className="group mt-3">
      {head && <p className="text-sm">{head}</p>}
      <p className={cn("text-pretty text-sm leading-relaxed", head && "mt-1")}>{short}</p>
      {more && (
        <>
          <Collapsible.Trigger className="mt-1 text-sm text-ink/60">
            <span className="group-data-[open]:hidden">展開全文</span>
            <span className="hidden group-data-[open]:inline">收合全文</span>
          </Collapsible.Trigger>
          <Collapsible.Panel>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink/80">{body}</p>
          </Collapsible.Panel>
        </>
      )}
    </Collapsible.Root>
  );
}

function Advice({ text }: { text: string }) {
  const split = text.indexOf(":");
  if (split === -1) return <p className="text-pretty mt-2 text-sm leading-relaxed">{text}</p>;
  return (
    <div className="mt-3">
      <p className="text-sm">{text.slice(0, split).trim()}</p>
      <p className="text-pretty mt-0.5 text-sm leading-relaxed text-ink/80">{text.slice(split + 1).trim()}</p>
    </div>
  );
}

function Result({ lines }: { lines: string[] }) {
  return (
    <div className="mt-6 max-w-xl">
      <h3 className="text-balance text-sm">結果</h3>
      {resultRows(lines).map((row, index) => {
        if (row.kind === "title") return <p key={index} className="text-pretty mt-2 font-serif text-lg leading-snug">{row.text}</p>;
        if (row.kind === "label") return <p key={index} className="mt-3 text-sm text-ink/60">{row.text}</p>;
        if (row.kind === "fact") {
          return (
            <p key={index} className="mt-2 flex gap-3 text-sm">
              <span className="w-20 shrink-0 text-ink/60">{row.text}</span>
              <span>{row.extra}</span>
            </p>
          );
        }
        return <p key={index} className="text-pretty mt-2 font-serif leading-relaxed">{row.text}</p>;
      })}
    </div>
  );
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-Hant", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function stateClass(run: Run): string {
  if (run.state === "running") return "text-signal";
  if (run.outcome === "failed") return "text-failed";
  return "text-ink";
}
