import { useEffect, useId, useReducer, useRef, useState } from "react";
import { COMMANDS, type Body, type CommandDef, type CommandId, type Field } from "../commands";
import { postCommand } from "./api";
import { cn } from "./cn";
import { confirmReady, initialState, reduce } from "./dialog-state";
import { exitInfo } from "./exit-info";
import { Modal } from "./Modal";

const TONE = { ok: "text-signal", warn: "text-warn", fail: "text-failed" } as const;
const MARK = { ok: "✓", warn: "!", fail: "✕" } as const;

const input = "min-h-11 w-full rounded-lg border border-line bg-wall px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";
const btn = "min-h-11 rounded-lg border border-line px-4 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal disabled:opacity-50";

function canPreview(def: CommandDef, body: Body): boolean {
  return def.fields.some((f) => f.name === "dryRun") && body.dryRun !== true && !body.undo;
}

export function CommandDialog({
  id,
  open,
  title,
  fixed,
  initial,
  fieldOptions,
  onClose,
}: {
  id: CommandId;
  open: boolean;
  title?: string;
  fixed?: Body;
  initial?: Body;
  fieldOptions?: Record<string, readonly string[]>;
  onClose: () => void;
}) {
  const def = COMMANDS[id];
  const [values, setValues] = useState<Body>(initial ?? {});
  const [state, dispatch] = useReducer(reduce, initialState);
  const [preview, setPreview] = useState<string>();
  const [sentBody, setSentBody] = useState<Body>({});
  // Bumped on every (re)open so a late dry-run preview can never land on a fresh session.
  const session = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog (re)opens, not when `initial` is a new object each render.
  useEffect(() => {
    if (!open) return;
    session.current += 1;
    setValues(initial ?? {});
    setPreview(undefined);
    dispatch({ type: "reset" });
  }, [open]);

  const send = async (extra: Body = {}) => {
    const body = { ...values, ...fixed, ...extra };
    const mine = session.current;
    setSentBody(body);
    dispatch({ type: "submit" });
    const result = await postCommand(id, body);
    if (result.kind === "need" && canPreview(def, body)) {
      void postCommand(id, { ...body, dryRun: true, confirm: undefined, confirmText: undefined }).then((p) => {
        if (p.kind === "short" && session.current === mine) setPreview(p.result.stdout || p.result.stderr);
      });
    }
    dispatch({ type: "result", result });
  };

  const shown = def.fields.filter((f) => !(fixed && f.name in fixed));
  const running = state.phase === "running";

  return (
    <Modal open={open} title={title ?? def.label} onClose={onClose} closable={!running}>
      {(state.phase === "form" || state.phase === "running") && (
        <form
          className="mt-4 flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!running) void send();
          }}
        >
          {shown.map((f, i) => (
            <FieldRow
              key={f.name}
              field={f}
              value={values[f.name]}
              error={state.phase === "form" ? state.errors[f.name] : undefined}
              options={fieldOptions?.[f.name]}
              autoFocus={i === 0}
              onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
            />
          ))}
          {state.phase === "form" && state.notice && (
            <p role="alert" className="text-pretty rounded-lg border border-failed/40 bg-failed-soft px-3 py-2 text-sm text-failed">
              {state.notice}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" disabled={running} className={btn} onClick={onClose}>
              取消
            </button>
            <button type="submit" disabled={running} className={cn(btn, "bg-ink text-paper")}>
              {running ? "執行中…" : def.label}
            </button>
          </div>
        </form>
      )}

      {state.phase === "confirm" && (
        <div className="mt-4 flex flex-col gap-4">
          <p className="text-pretty text-sm">
            這個動作不能復原。確定要{def.label}
            {typeof sentBody.run === "string" ? `（${sentBody.run}）` : typeof sentBody.name === "string" ? `（${sentBody.name}）` : ""}嗎？
          </p>
          {preview !== undefined && (
            <div>
              <p className="eyebrow">預覽（不會改動任何東西）</p>
              <pre className="mt-1 max-h-60 overflow-auto rounded-lg border border-line bg-wall p-3 font-mono text-xs whitespace-pre-wrap">{preview}</pre>
            </div>
          )}
          {state.need === "typed" && (
            <label className="flex flex-col gap-1 text-sm">
              <span>
                輸入 <strong className="font-mono">{state.target}</strong> 以確認
              </span>
              <input className={input} value={state.typed} autoComplete="off" onChange={(e) => dispatch({ type: "typed", value: e.target.value })} />
            </label>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            {/* Cancel is the default focus: Enter must not delete anything. */}
            {/* biome-ignore lint/a11y/noAutofocus: focus moves into the dialog on purpose */}
            <button type="button" autoFocus className={btn} onClick={onClose}>
              取消
            </button>
            <button type="button" className={btn} onClick={() => dispatch({ type: "back" })}>
              回上一步
            </button>
            <button
              type="button"
              disabled={!confirmReady(state)}
              className={cn(btn, "border-failed bg-failed text-paper")}
              onClick={() => void send({ confirm: true, ...(state.need === "typed" ? { confirmText: state.typed } : {}) })}
            >
              確定{def.label}
            </button>
          </div>
        </div>
      )}

      {state.phase === "done" && <Done result={state.result} onClose={onClose} />}
    </Modal>
  );
}

function Done({ result, onClose }: { result: Extract<ReturnType<typeof reduce>, { phase: "done" }>["result"]; onClose: () => void }) {
  if (result.kind === "job") {
    return (
      <div className="mt-4 flex flex-col gap-4">
        <p className="text-sm">
          <span aria-hidden className="mr-1 text-signal">✓</span>已在背景啟動（pid {result.job.pid}）。關掉這個頁面也會繼續跑。
        </p>
        <div className="flex justify-end gap-2">
          <a className={cn(btn, "inline-flex items-center")} href="#!jobs" onClick={onClose}>
            看任務輸出
          </a>
          {/* biome-ignore lint/a11y/noAutofocus: focus moves into the dialog on purpose */}
          <button type="button" autoFocus className={cn(btn, "bg-ink text-paper")} onClick={onClose}>
            關閉
          </button>
        </div>
      </div>
    );
  }
  if (result.kind !== "short") return null;
  const info = exitInfo(result.result.exit, result.result.timedOut);
  const text = [result.result.stdout, result.result.stderr].filter(Boolean).join("\n");
  return (
    <div className="mt-4 flex flex-col gap-4">
      <p className={cn("flex flex-wrap items-center gap-2 text-sm font-medium", TONE[info.tone])}>
        <span aria-hidden>{MARK[info.tone]}</span>
        {info.text}
        {result.result.signal ? <span className="font-mono text-xs">（訊號 {result.result.signal}）</span> : null}
      </p>
      {text && <pre className="max-h-80 overflow-auto rounded-lg border border-line bg-wall p-3 font-mono text-xs whitespace-pre-wrap">{text}</pre>}
      {result.result.truncated && <p className="text-xs text-ink/60">輸出太長，已截斷。</p>}
      <div className="flex justify-end">
        {/* biome-ignore lint/a11y/noAutofocus: focus moves into the dialog on purpose */}
        <button type="button" autoFocus className={cn(btn, "bg-ink text-paper")} onClick={onClose}>
          關閉
        </button>
      </div>
    </div>
  );
}

function FieldRow({
  field,
  value,
  error,
  options,
  autoFocus,
  onChange,
}: {
  field: Field;
  value: unknown;
  error: string | undefined;
  options: readonly string[] | undefined;
  autoFocus: boolean;
  onChange: (value: unknown) => void;
}) {
  const uid = useId();
  const errId = `${uid}-err`;
  // biome-ignore lint/a11y/noAutofocus: focus moves into the dialog on purpose
  const common = { id: uid, "aria-invalid": error ? true : undefined, "aria-describedby": error ? errId : undefined, autoFocus };
  const choices = options ?? field.options;
  return (
    <div className="flex flex-col gap-1">
      {field.kind === "checkbox" ? (
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input type="checkbox" className="size-5" checked={value === true} onChange={(e) => onChange(e.target.checked)} {...common} />
          <span>{field.label}</span>
        </label>
      ) : (
        <>
          <label htmlFor={uid} className="text-sm font-medium">
            {field.label}
            {field.required && <span aria-hidden className="text-failed"> *</span>}
          </label>
          {field.kind === "textarea" ? (
            <textarea className={cn(input, "min-h-32")} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} {...common} />
          ) : choices ? (
            <select className={input} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} {...common}>
              <option value="">{field.required ? "請選擇" : "（預設）"}</option>
              {choices.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input className={input} value={typeof value === "string" ? value : ""} autoComplete="off" onChange={(e) => onChange(e.target.value)} {...common} />
          )}
        </>
      )}
      {field.help && !error && <p className="text-xs text-ink/60">{field.help}</p>}
      {error && (
        <p id={errId} role="alert" className="text-sm text-failed">
          {error}
        </p>
      )}
    </div>
  );
}
