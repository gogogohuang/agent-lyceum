import { useState } from "react";
import type { CommandId } from "../commands";
import type { Run } from "../types";
import { AnswerDialog } from "./AnswerDialog";
import { ReportsDialog } from "./ReportsDialog";
import { CommandDialog } from "./CommandDialog";
import { isIdleRun, isRunControlLocked } from "./run-state";
import { forgetDeletedSummaries } from "./summary-cleanup";

type Open = { id: CommandId; initial?: Record<string, unknown>; title?: string } | "answer" | "reports" | undefined;

const btn = "min-h-11 rounded-lg border border-line bg-paper px-3 text-sm hover:bg-wall focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:cursor-not-allowed disabled:opacity-50";

export function RunActions({ project, run }: { project: string; run?: Run }) {
  const [open, setOpen] = useState<Open>();
  const close = () => setOpen(undefined);
  const idle = isIdleRun(run);
  const waiting = !!run?.ask && run.ask.unanswered > 0;
  const locked = isRunControlLocked(run);
  return (
    <>
      <div role="toolbar" aria-label="操作" className="flex flex-wrap gap-2">
        <button type="button" className={btn} disabled={locked} onClick={() => setOpen({ id: "run" })}>
          新任務
        </button>
        {waiting && run && (
          <button type="button" className={`${btn} border-warn/60 bg-warn-soft text-warn`} disabled={locked} onClick={() => setOpen("answer")}>
            回答問題（{run.ask?.unanswered}）
          </button>
        )}
        {idle && run && (
          <>
            <button type="button" className={btn} disabled={locked} onClick={() => setOpen({ id: "resume", initial: { run: run.run_id } })}>
              續跑／追問
            </button>
            <button type="button" className={btn} disabled={isRunControlLocked(run, "clear")} onClick={() => setOpen({ id: "clear", initial: { run: run.run_id } })}>
              刪除這次任務
            </button>
          </>
        )}
        {run && (
          <button type="button" className={btn} disabled={locked} onClick={() => setOpen("reports")}>
            查看報告
          </button>
        )}
        <button type="button" className={btn} disabled={locked} onClick={() => setOpen({ id: "tidy", initial: run ? { run: run.run_id } : undefined })}>
          整理記憶
        </button>
        <button type="button" className={btn} disabled={locked} onClick={() => setOpen({ id: "doctor" })}>
          檢查設定
        </button>
        {locked && <p className="text-pretty basis-full text-sm text-ink/70">這個任務已 tidy，除了刪除以外不能再操作。</p>}
      </div>
      {open && open !== "answer" && open !== "reports" && <CommandDialog id={open.id} open fixed={{ project }} initial={open.initial} onShortResult={forgetDeletedSummaries} onClose={close} />}
      {run && <ReportsDialog project={project} runId={run.run_id} open={open === "reports"} onClose={close} />}
      {run && <AnswerDialog project={project} runId={run.run_id} open={open === "answer"} onClose={close} />}
    </>
  );
}
