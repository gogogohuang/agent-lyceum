import { useEffect, useMemo, useState } from "react";
import { getDecision, getDecisions, type DecisionDoc, type DecisionGroup, type DecisionItem } from "./api";
import { cn } from "./cn";
import { renderMarkdown } from "./markdown";

const STATUS: Record<DecisionItem["status"], string> = { active: "有效", superseded: "已被取代" };
const chip = "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg border px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";

type Pick = { project: string; id: string };

/** Decisions of every registered project, shown as ADRs. They are read from the project records, so they stay after `clear`. */
export function DecisionsPage() {
  const [groups, setGroups] = useState<DecisionGroup[] | "error">();
  const [project, setProject] = useState<string>();
  const [showOld, setShowOld] = useState(false);
  const [pick, setPick] = useState<Pick>();

  useEffect(() => {
    let live = true;
    void getDecisions().then((g) => live && setGroups(g ?? "error"));
    return () => {
      live = false;
    };
  }, []);

  const list = Array.isArray(groups) ? groups : [];
  const current = list.find((g) => g.project === project) ?? list.find((g) => g.decisions.length > 0) ?? list[0];
  const shown = (current?.decisions ?? []).filter((d) => showOld || d.status === "active");
  const hidden = (current?.decisions.length ?? 0) - shown.length;

  return (
    <article className="enter animate-in fade-in p-4 duration-200 sm:p-6">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">決策</h1>
      <p className="text-pretty mt-2 text-sm text-ink/70">依專案分類，以 ADR 格式呈現。資料來自專案紀錄，清除任務後仍會保留。</p>
      {groups === undefined ? (
        <p role="status" className="mt-6 text-sm">讀取中…</p>
      ) : groups === "error" ? (
        <p role="alert" className="mt-6 text-sm text-failed">讀不到決策，請重新整理頁面。</p>
      ) : list.length === 0 ? (
        <p className="mt-6 text-sm">還沒有已註冊的專案。</p>
      ) : (
        <>
          <ul aria-label="專案" className="mt-5 flex gap-2 overflow-x-auto pb-1">
            {list.map((g) => {
              const on = g.project === current?.project;
              return (
                <li key={g.project}>
                  <button
                    type="button"
                    aria-pressed={on}
                    className={cn(chip, on ? "border-line bg-paper font-medium" : "border-transparent hover:bg-paper/70")}
                    onClick={() => {
                      setProject(g.project);
                      setPick(undefined);
                    }}
                  >
                    <span className="truncate">{g.project}</span>
                    <span className="font-mono text-xs tabular-nums text-ink/60">{g.decisions.filter((d) => d.status === "active").length}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {current?.error && <p role="alert" className="mt-4 text-sm text-failed">{current.error}</p>}
          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
            <section aria-label="決策列表">
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-[var(--c-signal)]" checked={showOld} onChange={(e) => setShowOld(e.target.checked)} />
                顯示已被取代的決策{hidden > 0 && !showOld ? `（${hidden}）` : ""}
              </label>
              {shown.length === 0 ? (
                <p className="panel mt-2 p-4 text-sm text-ink/70">{current && current.decisions.length === 0 ? "這個專案還沒有決策紀錄。" : "沒有有效的決策。"}</p>
              ) : (
                <ul className="mt-2 grid gap-2">
                  {shown.map((d) => {
                    const on = pick?.project === current?.project && pick?.id === d.id;
                    return (
                      <li key={d.id}>
                        <button
                          type="button"
                          aria-current={on ? "true" : undefined}
                          className={cn("panel block min-h-11 w-full p-3 text-left hover:bg-wall focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal", on && "border-signal", d.status === "superseded" && "opacity-70")}
                          onClick={() => current && setPick({ project: current.project, id: d.id })}
                        >
                          <span className="block font-mono text-xs tabular-nums text-ink/60">{d.date || "日期不明"} · {d.id}</span>
                          <span className="text-pretty mt-1 block text-sm font-medium">{d.title}</span>
                          <StatusBadge item={d} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            <section aria-label="決策內容" aria-live="polite">
              {pick ? <Adr key={`${pick.project}/${pick.id}`} pick={pick} onJump={(id) => setPick({ project: pick.project, id })} /> : <p className="panel p-4 text-sm text-ink/70">從左邊選一個決策來閱讀。</p>}
            </section>
          </div>
        </>
      )}
    </article>
  );
}

function StatusBadge({ item }: { item: DecisionItem }) {
  return (
    <span className={cn("mt-2 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs", item.status === "active" ? "bg-signal-soft text-signal" : "bg-warn-soft text-warn")}>
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {STATUS[item.status]}
      {item.invalid ? "・格式有問題" : ""}
    </span>
  );
}

function Adr({ pick, onJump }: { pick: Pick; onJump: (id: string) => void }) {
  const [doc, setDoc] = useState<DecisionDoc | "error">();
  useEffect(() => {
    let live = true;
    void getDecision(pick.project, pick.id).then((d) => live && setDoc(d ?? "error"));
    return () => {
      live = false;
    };
  }, [pick.project, pick.id]);
  const html = useMemo(() => (doc && doc !== "error" ? renderMarkdown(doc.markdown) : ""), [doc]);
  if (doc === undefined) return <p role="status" className="panel p-4 text-sm">讀取中…</p>;
  if (doc === "error") return <p role="alert" className="panel p-4 text-sm text-failed">找不到這個決策。</p>;
  const link = (ids: string[]) => ids.map((id) => (
    <button key={id} type="button" className="mr-2 min-h-11 font-mono text-xs underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal" onClick={() => onJump(id)}>{id}</button>
  ));
  return (
    <div className="panel p-4 sm:p-6">
      <p className="eyebrow">ADR · {pick.project}</p>
      <h2 className="text-balance mt-1 text-xl font-semibold tracking-tight">{doc.title}</h2>
      <dl className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 border-y border-line py-3 text-sm">
        <dt className="text-ink/60">狀態</dt>
        <dd><StatusBadge item={doc} /></dd>
        <dt className="text-ink/60">日期</dt>
        <dd className="font-mono tabular-nums">{doc.date || "不明"}</dd>
        {doc.run && (<><dt className="text-ink/60">來源任務</dt><dd className="truncate font-mono text-xs">{doc.run}</dd></>)}
        {doc.supersedes.length > 0 && (<><dt className="text-ink/60">取代</dt><dd>{link(doc.supersedes)}</dd></>)}
        {doc.supersededBy.length > 0 && (<><dt className="text-ink/60">被取代於</dt><dd>{link(doc.supersededBy)}</dd></>)}
      </dl>
      {doc.invalid && <p role="alert" className="mt-3 text-sm text-failed">這份紀錄的格式有問題：{doc.invalid}</p>}
      <article className="report-prose mt-4" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
