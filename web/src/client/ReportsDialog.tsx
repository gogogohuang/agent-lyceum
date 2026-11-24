import { useEffect, useMemo, useState } from "react";
import { getReport, getReports, type ReportDoc, type ReportItem } from "./api";
import { renderMarkdown } from "./markdown";
import { Modal } from "./Modal";

const btn = "min-h-11 rounded-lg border border-line bg-paper px-3 text-sm hover:bg-wall focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal";
const KIND: Record<ReportItem["kind"], string> = { result: "最終結果", done: "完成回報", agent: "Agent 報告" };

function when(iso?: string): string {
  const date = iso ? new Date(iso) : undefined;
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-Hant", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function ReportsDialog({ project, runId, open, onClose }: { project: string; runId: string; open: boolean; onClose: () => void }) {
  const [items, setItems] = useState<ReportItem[] | "error">();
  const [doc, setDoc] = useState<ReportDoc | "error" | "loading">();
  useEffect(() => {
    if (!open) return;
    setItems(undefined);
    setDoc(undefined);
    let live = true;
    void getReports(project, runId).then((r) => live && setItems(r ?? "error"));
    return () => {
      live = false;
    };
  }, [open, project, runId]);
  const pick = (id: string) => {
    setDoc("loading");
    void getReport(project, runId, id).then((d) => setDoc(d ?? "error"));
  };
  const html = useMemo(() => (doc && typeof doc === "object" ? renderMarkdown(doc.markdown) : ""), [doc]);
  const title = doc && typeof doc === "object" ? doc.title : "報告";
  return (
    <Modal open={open} title={title} onClose={onClose} wide>
      {doc === undefined ? (
        <List items={items} onPick={pick} />
      ) : (
        <div className="mt-3">
          <button type="button" className={btn} onClick={() => setDoc(undefined)}>
            ← 回到列表
          </button>
          {doc === "loading" && <p className="mt-4 text-sm">載入中…</p>}
          {doc === "error" && <p className="mt-4 text-sm text-failed">讀不到這份報告。</p>}
          {typeof doc === "object" && <article className="report-prose mt-4" dangerouslySetInnerHTML={{ __html: html }} />}
        </div>
      )}
      <div className="mt-6 flex justify-end">
        <button type="button" className={btn} onClick={onClose}>
          關閉
        </button>
      </div>
    </Modal>
  );
}

function List({ items, onPick }: { items: ReportItem[] | "error" | undefined; onPick: (id: string) => void }) {
  if (items === undefined) return <p className="mt-4 text-sm">載入中…</p>;
  if (items === "error") return <p className="mt-4 text-sm text-failed">讀不到報告列表。</p>;
  if (items.length === 0) return <p className="mt-4 text-sm">這次任務還沒有報告。</p>;
  return (
    <ul className="mt-4 flex flex-col gap-2">
      {items.map((item) => (
        <li key={item.id}>
          <button type="button" className={`${btn} block w-full py-2 text-left`} onClick={() => onPick(item.id)}>
            <span className="flex items-baseline justify-between gap-3 font-mono text-xs tabular-nums text-ink/70">
              <span>{item.agent ? `${KIND[item.kind]}・${item.agent}` : KIND[item.kind]}</span>
              <span>{when(item.created)}</span>
            </span>
            <span className="text-pretty mt-1 block text-sm font-medium">{item.title}</span>
            {item.outcome && <span className="mt-0.5 block text-xs text-ink/60">{item.outcome}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}
