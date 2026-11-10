import { useState } from "react";
import type { CommandId } from "../commands";
import type { Run } from "../types";
import { AnswerDialog } from "./AnswerDialog";
import { CommandDialog } from "./CommandDialog";

type Open = { id: CommandId; initial?: Record<string, unknown>; title?: string } | "answer" | undefined;

const btn = "min-h-11 rounded-lg border border-line bg-paper px-3 text-sm hover:bg-wall focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

export function RunActions({ project, run }: { project: string; run?: Run }) {
  const [open, setOpen] = useState<Open>();
  const close = () => setOpen(undefined);
  const idle = run && run.state !== "running";
  const waiting = !!run?.ask && run.ask.unanswered > 0;
  return (
    <>
      <div role="toolbar" aria-label="操作" className="flex flex-wrap gap-2">
        <button type="button" className={btn} onClick={() => setOpen({ id: "run" })}>
          新任務
        </button>
        {waiting && run && (
          <button type="button" className={`${btn} border-warn/60 bg-warn-soft text-warn`} onClick={() => setOpen("answer")}>
            回答問題（{run.ask?.unanswered}）
          </button>
        )}
        {idle && run && (
          <>
            <button type="button" className={btn} onClick={() => setOpen({ id: "resume", initial: { run: run.run_id } })}>
              續跑／追問
            </button>
            <button type="button" className={btn} onClick={() => setOpen({ id: "clear", initial: { run: run.run_id } })}>
              刪除這次任務
            </button>
          </>
        )}
        <button type="button" className={btn} onClick={() => setOpen({ id: "tidy" })}>
          整理記憶
        </button>
        <button type="button" className={btn} onClick={() => setOpen({ id: "doctor" })}>
          檢查設定
        </button>
      </div>
      {open && open !== "answer" && <CommandDialog id={open.id} open fixed={{ project }} initial={open.initial} onClose={close} />}
      {run && <AnswerDialog project={project} runId={run.run_id} open={open === "answer"} onClose={close} />}
    </>
  );
}
