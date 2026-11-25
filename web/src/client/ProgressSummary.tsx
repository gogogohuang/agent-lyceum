import { Button } from "@base-ui/react/button";
import { useState } from "react";
import { summaries } from "./summary-store";

export function ProgressSummary({ project, runId, locked = false }: { project: string; runId: string; locked?: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [text, setText] = useState<string | undefined>(() => summaries.load(project, runId)?.text);

  const summarize = () => {
    setPending(true);
    setError(undefined);
    void fetch("/summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, runId }),
    })
      .then(readSummary)
      .then((next) => {
        summaries.save(project, runId, { text: next, generatedAt: Date.now() });
        setText(next);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "沒有寫出摘要。"))
      .finally(() => setPending(false));
  };

  return (
    <>
      <Button
        type="button"
        disabled={pending || locked}
        className="panel shrink-0 self-stretch px-4 text-sm font-medium hover:bg-wall disabled:cursor-not-allowed disabled:opacity-60"
        onClick={() => {
          if (locked) return;
          summarize();
        }}
      >
        {pending ? "正在總結" : "總結進度"}
      </Button>
      {(error || pending || text) && (
        <div className="basis-full" aria-live="polite">
          {error && <p className="text-pretty mt-3 text-sm text-failed">{error}</p>}
          {pending && (
            <div className="mt-4 space-y-2" aria-hidden="true">
              <div className="h-3 animate-pulse rounded bg-line" />
              <div className="h-3 w-2/3 animate-pulse rounded bg-line" />
            </div>
          )}
          {!pending && text && (
            <div className="panel mt-3 px-4 pb-4">
              {paragraphs(text).map((paragraph, index) => (
                <p key={`${index}-${paragraph.slice(0, 24)}`} className="text-pretty mt-4 text-base leading-relaxed">
                  {paragraph}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}

function paragraphs(text: string): string[] {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((part) => part.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean);
}

async function readSummary(response: Response): Promise<string> {
  let body: { text?: string; error?: string } = {};
  try {
    body = (await response.json()) as { text?: string; error?: string };
  } catch {
    throw new Error("沒有寫出摘要。");
  }
  if (!response.ok || !body.text?.trim()) throw new Error(body.error || "沒有寫出摘要。");
  return body.text.trim();
}
