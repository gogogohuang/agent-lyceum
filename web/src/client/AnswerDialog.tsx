import { useEffect, useId, useState } from "react";
import { getAsk, postAnswers, postCommand, type AskView, type CommandResult } from "./api";
import { cn } from "./cn";
import { exitInfo } from "./exit-info";
import { Modal } from "./Modal";

const input = "min-h-11 w-full rounded-lg border border-line bg-wall px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";
const btn = "min-h-11 rounded-lg border border-line px-4 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:opacity-50";

export function AnswerDialog({ project, runId, open, onClose }: { project: string; runId: string; open: boolean; onClose: () => void }) {
  const [ask, setAsk] = useState<AskView | undefined | "missing">();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [useDefaults, setUseDefaults] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [result, setResult] = useState<CommandResult>();

  useEffect(() => {
    if (!open) return;
    let current = true;
    setAsk(undefined);
    setAnswers({});
    setUseDefaults(false);
    setProblems([]);
    setResult(undefined);
    setBusy(false);
    void getAsk(project, runId).then((view) => {
      if (!current) return;
      setAsk(view ?? "missing");
      if (view) setAnswers(Object.fromEntries(view.questions.filter((q) => !q.delivered && q.answer).map((q) => [q.id, q.answer as string])));
    });
    return () => {
      current = false;
    };
  }, [open, project, runId]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setProblems([]);
    const saved = await postAnswers(project, runId, answers, useDefaults);
    if (!saved) {
      setProblems(["沒能存下答案，請重新整理頁面再試。"]);
    } else if (!saved.complete) {
      setProblems(saved.problems);
    } else {
      setResult(await postCommand("resume", { project, run: runId, answer: true }));
    }
    setBusy(false);
  };

  const pending = ask && ask !== "missing" ? ask.questions.filter((q) => !q.delivered) : [];
  const info = result?.kind === "short" ? exitInfo(result.result.exit, result.result.timedOut) : undefined;

  return (
    <Modal open={open} title="回答問題" onClose={onClose} closable={!busy}>
      {ask === undefined && <p className="mt-4 text-sm">讀取中…</p>}
      {ask === "missing" && <p className="mt-4 text-sm">這次任務現在沒有待回答的問題。</p>}
      {result ? (
        <div className="mt-4 flex flex-col gap-3">
          {result.kind === "job" ? (
            <p className="text-sm">
              <span aria-hidden className="mr-1 text-signal">✓</span>答案已送出，任務在背景繼續。
            </p>
          ) : result.kind === "short" ? (
            <>
              <p className={cn("text-sm font-medium", info?.tone === "ok" ? "text-signal" : info?.tone === "warn" ? "text-warn" : "text-failed")}>
                {info?.text}
                {result.result.signal ? <span className="ml-2 font-mono text-xs">（訊號 {result.result.signal}）</span> : null}
              </p>
              <pre className="max-h-60 overflow-auto rounded-lg border border-line bg-wall p-3 font-mono text-xs whitespace-pre-wrap">{result.result.stdout || result.result.stderr}</pre>
            </>
          ) : (
            <p role="alert" className="text-pretty text-sm text-failed">
              {result.kind === "error" ? result.message : result.kind === "invalid" ? result.error : "請求被拒絕，請重新整理頁面後再試。"}
            </p>
          )}
          <div className="flex justify-end">
            {/* biome-ignore lint/a11y/noAutofocus: focus moves into the dialog on purpose */}
            <button type="button" autoFocus className={cn(btn, "bg-ink text-paper")} onClick={onClose}>
              關閉
            </button>
          </div>
        </div>
      ) : (
        pending.length > 0 && (
          <form
            className="mt-4 flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            {pending.map((q, i) => (
              <Question key={q.id} q={q} value={answers[q.id] ?? ""} autoFocus={i === 0} onChange={(v) => setAnswers((prev) => ({ ...prev, [q.id]: v }))} />
            ))}
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input type="checkbox" className="size-5" checked={useDefaults} onChange={(e) => setUseDefaults(e.target.checked)} />
              <span>沒填的問題，有建議值就採用建議值</span>
            </label>
            {problems.length > 0 && (
              <ul role="alert" className="rounded-lg border border-failed/40 bg-failed-soft px-3 py-2 text-sm text-failed">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" disabled={busy} className={btn} onClick={onClose}>
                取消
              </button>
              <button type="submit" disabled={busy} className={cn(btn, "bg-ink text-paper")}>
                {busy ? "送出中…" : "送出並繼續任務"}
              </button>
            </div>
          </form>
        )
      )}
      {(ask === "missing" || (ask !== undefined && !result && pending.length === 0)) && (
        <div className="mt-4 flex justify-end">
          <button type="button" className={btn} onClick={onClose}>
            關閉
          </button>
        </div>
      )}
    </Modal>
  );
}

function Question({ q, value, autoFocus, onChange }: { q: AskView["questions"][number]; value: string; autoFocus: boolean; onChange: (v: string) => void }) {
  const uid = useId();
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-pretty text-sm font-medium">
        {q.text} <span className="font-mono text-xs text-ink/60">（{q.asker}）</span>
      </legend>
      {q.options?.map((o) => (
        <label key={o} className="flex min-h-11 items-center gap-3 text-sm">
          <input type="radio" name={uid} className="size-5" checked={value === o} onChange={() => onChange(o)} />
          <span className="text-pretty">{o}</span>
        </label>
      ))}
      <label htmlFor={`${uid}-text`} className="text-xs text-ink/60">
        {q.options?.length ? "或自己寫" : "你的答案"}
      </label>
      {/* biome-ignore lint/a11y/noAutofocus: focus moves into the dialog on purpose */}
      <input id={`${uid}-text`} className={input} value={value} autoFocus={autoFocus} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
      {q.suggested && (
        <button type="button" className="min-h-11 self-start rounded-lg px-1 text-left text-sm underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal" onClick={() => onChange(q.suggested?.value ?? "")}>
          採用建議：{q.suggested.value}
          {q.suggested.reason ? `（${q.suggested.reason}）` : ""}
        </button>
      )}
    </fieldset>
  );
}
