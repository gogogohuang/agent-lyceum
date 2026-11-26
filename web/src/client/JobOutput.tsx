import type { JobDetail } from "./api";
import { cn } from "./cn";
import { exitInfo } from "./exit-info";
import { jobLabel } from "./job-label";
import { formatElapsed, parseJobLog, type Block, type BranchConclusion, type Conclusion, type EndedConclusion, type ErrorBlock, type NextConclusion, type RoundBlock, type SkippedBlock, type TextBlock, type TidiedBlock } from "./job-log";

const OUTCOME: Record<string, string> = {
  completed: "完成",
  partial: "部分完成",
  blocked: "受阻",
  failed: "失敗",
  waiting: "等待回答",
  cancelled: "已取消",
};

const END_REASON: Record<string, string> = {
  done: "完成回報",
  lead_failed: "負責人失敗",
  agent_failed: "成員失敗",
  waiting: "等待回答",
  cancelled: "已取消",
  idle: "沒有後續",
  max_rounds: "達到輪數上限",
};

const STATE = { running: "執行中", lost: "已結束（結束碼不明）" } as const;

type Tone = "signal" | "warn" | "failed";

function statusOf(job: JobDetail): { text: string; tone: Tone } {
  if (job.state === "running") return { text: STATE.running, tone: "signal" };
  if (job.state === "lost") return { text: STATE.lost, tone: "warn" };
  const info = exitInfo(job.exit ?? null, false);
  return { text: info.text, tone: info.tone === "ok" ? "signal" : info.tone === "warn" ? "warn" : "failed" };
}

function clock(iso: string): string {
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : t.toLocaleString();
}

function elapsedOf(job: JobDetail): { label: string; text: string } | undefined {
  const started = new Date(job.started_at).getTime();
  if (Number.isNaN(started)) return undefined;
  if (job.state === "running") return { label: "已進行", text: formatElapsed(Date.now() - started) };
  if (!job.ended_at) return undefined;
  const ended = new Date(job.ended_at).getTime();
  if (Number.isNaN(ended)) return undefined;
  return { label: "耗時", text: formatElapsed(ended - started) };
}

const toneClass: Record<Tone, string> = { signal: "text-signal", warn: "text-warn", failed: "text-failed" };

const pre = "max-w-full overflow-auto whitespace-pre-wrap break-all font-mono text-xs";
const summaryBtn = "min-h-11 cursor-pointer rounded-sm py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

export function JobOutput({ job, stale, raw, onRaw }: { job: JobDetail; stale: boolean; raw: boolean; onRaw: (raw: boolean) => void }) {
  const label = jobLabel(job.argv);
  const status = statusOf(job);
  const elapsed = elapsedOf(job);
  const log = parseJobLog(job.tail, { truncated: job.truncated === true });
  const empty = job.tail === "" && log.partial === undefined;

  return (
    <section aria-label="任務詳情" className="min-w-0 max-w-full rounded-lg border border-line bg-wall p-3">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <dt className="text-ink/60">狀態</dt>
        <dd className={toneClass[status.tone]}>{status.text}</dd>
        {label.project && (
          <>
            <dt className="text-ink/60">專案</dt>
            <dd className="break-words font-mono">{label.project}</dd>
          </>
        )}
        {label.target && (
          <>
            <dt className="text-ink/60">目標</dt>
            <dd className="break-words font-medium">{label.target}</dd>
          </>
        )}
        <dt className="text-ink/60">開始</dt>
        <dd>
          <time dateTime={job.started_at}>{clock(job.started_at)}</time>
        </dd>
        {job.ended_at && (
          <>
            <dt className="text-ink/60">結束</dt>
            <dd>
              <time dateTime={job.ended_at}>{clock(job.ended_at)}</time>
            </dd>
          </>
        )}
        {elapsed && (
          <>
            <dt className="text-ink/60">{elapsed.label}</dt>
            <dd>{elapsed.text}</dd>
          </>
        )}
      </dl>
      <details className="mt-2">
        <summary className={cn(summaryBtn, "text-sm text-ink/70")}>完整指令</summary>
        <pre className={cn(pre, "mt-1 max-h-40 rounded-md border border-line bg-paper p-2")}>{job.argv.join(" ")}</pre>
      </details>
      {stale && <p className="mt-2 text-sm text-warn">更新失敗，稍後重試</p>}
      <div role="group" aria-label="輸出格式" className="mt-3 flex flex-wrap gap-2">
        <button type="button" aria-pressed={!raw} className={cn("min-h-11 rounded-full border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal", !raw ? "border-ink/40 bg-paper" : "border-line")} onClick={() => onRaw(false)}>
          整理後的輸出
        </button>
        <button type="button" aria-pressed={raw} className={cn("min-h-11 rounded-full border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal", raw ? "border-ink/40 bg-paper" : "border-line")} onClick={() => onRaw(true)}>
          原始輸出
        </button>
      </div>
      {log.truncated && <p className="mt-3 text-sm text-warn">輸出超過尾端上限，這裡只顯示最後的部分。</p>}
      {raw ? (
        <pre className={cn(pre, "mt-3 max-h-[60dvh] rounded-lg border border-line bg-paper p-3")}>{job.tail || "（還沒有輸出）"}</pre>
      ) : empty ? (
        <p className="mt-3 text-sm">（還沒有輸出）</p>
      ) : (
        <div className="mt-3 flex max-h-[60dvh] min-w-0 flex-col gap-3 overflow-auto">
          {log.partial !== undefined && (
            <details className="rounded-lg border border-line bg-paper px-3">
              <summary className={cn(summaryBtn, "text-sm text-ink/70")}>開頭被截斷的半行</summary>
              <pre className={cn(pre, "mb-2 max-h-40")}>{log.partial}</pre>
            </details>
          )}
          {log.conclusions.length > 0 && (
            <div className="flex flex-col gap-3 rounded-lg border border-line bg-paper p-3">
              {log.conclusions.map((item, index) => (
                <ConclusionView key={`${item.kind}-${index}`} item={item} />
              ))}
            </div>
          )}
          {log.blocks.map((block, index) => (
            <BlockView key={blockKey(block, index)} block={block} />
          ))}
        </div>
      )}
    </section>
  );
}

function blockKey(block: Block, index: number): string {
  if (block.kind === "round") return `round-${block.n}-${block.agent}-${index}`;
  if (block.kind === "tidied") return `tidied-${block.agent}-${block.layer}-${index}`;
  return `${block.kind}-${index}`;
}

function ConclusionView({ item }: { item: Conclusion }) {
  if (item.kind === "ended") return <EndedView item={item} />;
  if (item.kind === "next") return <NextView item={item} />;
  return <BranchView item={item} />;
}

function EndedView({ item }: { item: EndedConclusion }) {
  const outcome = OUTCOME[item.outcome] ?? item.outcome;
  const reason = END_REASON[item.endReason] ?? item.endReason;
  return (
    <div className="text-sm">
      <p>
        結束：{outcome}（{reason}），{item.rounds} 輪
      </p>
      <p className="mt-1 break-all text-xs text-ink/70">紀錄：{item.logs}</p>
      {item.note && <p className="mt-1 break-words text-ink/80">{item.note}</p>}
    </div>
  );
}

function NextView({ item }: { item: NextConclusion }) {
  return (
    <div>
      <h3 className="text-sm font-medium">下一步</h3>
      <ul className="mt-1 flex flex-col gap-1">
        {item.lines.map((line, index) => (
          <li key={index} className="break-all font-mono text-xs">
            {line}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BranchView({ item }: { item: BranchConclusion }) {
  return (
    <div className="text-sm">
      <p className="break-words">
        結果在分支 <span className="break-all font-mono">{item.branch}</span>（{item.files} 個檔案），工作目錄沒有被改動。
      </p>
      {item.bringIn && <p className="mt-1 break-all font-mono text-xs">帶進來：{item.bringIn}</p>}
      {item.patch && <p className="mt-1 break-all font-mono text-xs">或套用補丁：{item.patch}</p>}
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  if (block.kind === "round") return <RoundView block={block} />;
  if (block.kind === "error") return <ErrorView block={block} />;
  if (block.kind === "text") return <TextView block={block} />;
  if (block.kind === "skipped") return <SkippedView block={block} />;
  if (block.kind === "tidied") return <TidiedView block={block} />;
  return <p className="break-words text-sm">{block.text}</p>;
}

function RoundView({ block }: { block: RoundBlock }) {
  const who = block.model ? `${block.runtime}/${block.model}` : block.runtime;
  const bits = [`第 ${block.n}${block.max ? `/${block.max}` : ""} 輪`, block.agent, who];
  if (block.tier) bits.push(`層級 ${block.tier}`);
  if (block.retry) bits.push(`重試 ${block.retry}`);
  return (
    <section className="rounded-lg border border-line bg-paper p-3">
      <h3 className="break-words text-sm font-medium">{bits.join(" · ")}</h3>
      {block.body.length > 0 && (
        <div className="mt-2 flex flex-col gap-2">
          {block.body.map((leaf, index) => (leaf.kind === "error" ? <ErrorView key={`e-${index}`} block={leaf} /> : <TextView key={`t-${index}`} block={leaf} />))}
        </div>
      )}
    </section>
  );
}

function ErrorView({ block }: { block: ErrorBlock }) {
  return (
    <div className="rounded-md border border-failed/40 bg-failed-soft px-3 py-2">
      <p className="break-words text-sm text-failed">
        {block.message}
        {block.count > 1 ? `（連續 ${block.count} 次）` : ""}
      </p>
      <details>
        <summary className={cn(summaryBtn, "text-xs text-ink/60")}>原始片段</summary>
        <pre className={cn(pre, "mb-2 max-h-40")}>{block.raw}</pre>
      </details>
    </div>
  );
}

function TextView({ block }: { block: TextBlock }) {
  return <pre className={pre}>{block.text}</pre>;
}

function SkippedView({ block }: { block: SkippedBlock }) {
  return (
    <details className="rounded-lg border border-line bg-paper px-3">
      <summary className={cn(summaryBtn, "text-sm")}>略過 {block.count} 個</summary>
      <ul className="mb-2 flex flex-col gap-1 text-sm">
        {block.items.map((item, index) => (
          <li key={`${item.agent}-${item.layer}-${index}`} className="break-words">
            {item.agent}（{item.layer}）：{item.reason}
          </li>
        ))}
      </ul>
    </details>
  );
}

function TidiedView({ block }: { block: TidiedBlock }) {
  return (
    <div className="rounded-lg border border-line bg-paper px-3 py-2 text-sm">
      <p className="break-words">
        {block.agent}（{block.layer}）已整理
      </p>
      <details>
        <summary className={cn(summaryBtn, "text-ink/70")}>封存路徑與還原指令</summary>
        <dl className="mb-2 space-y-1 break-all font-mono text-xs">
          <div>
            <dt className="text-ink/60">封存</dt>
            <dd>{block.archive}</dd>
          </div>
          {block.records && (
            <div>
              <dt className="text-ink/60">紀錄封存</dt>
              <dd>{block.records}</dd>
            </div>
          )}
          {block.proposals && (
            <div>
              <dt className="text-ink/60">提案封存</dt>
              <dd>{block.proposals}</dd>
            </div>
          )}
          <div>
            <dt className="text-ink/60">還原</dt>
            <dd>{block.undo}</dd>
          </div>
        </dl>
      </details>
    </div>
  );
}
