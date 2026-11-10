import type { Body, CommandId } from "../commands";

export type ShortOutcome = { mode: "short"; exit: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean; truncated: boolean };
export type CommandResult =
  | { kind: "short"; result: ShortOutcome }
  | { kind: "job"; job: { jobId: string; pid: number } }
  | { kind: "need"; need: "confirm" | "typed"; target?: string }
  | { kind: "invalid"; error: string; field?: string }
  | { kind: "stale" }
  | { kind: "error"; message: string };

export type JobSummary = { id: string; command: string; argv: string[]; cwd: string; started_at: string; pid: number; state: "running" | "ended" | "lost"; exit?: number | null; ended_at?: string };
export type JobDetail = JobSummary & { tail: string };
export type AskQuestion = { id: string; text: string; asker: string; options?: string[]; suggested?: { value: string; reason?: string }; answer?: string; delivered: boolean };
export type AskView = { status: "pending" | "answered"; questions: AskQuestion[] };

function token(): string {
  return document.querySelector('meta[name="lyceum-token"]')?.getAttribute("content") ?? "";
}

const headers = () => ({ "Content-Type": "application/json", "X-Lyceum-Token": token() });

async function json(res: Response): Promise<Record<string, unknown>> {
  return ((await res.json().catch(() => ({}))) as Record<string, unknown>) ?? {};
}

export async function postCommand(id: CommandId, body: Body): Promise<CommandResult> {
  let res: Response;
  try {
    res = await fetch(`/api/cmd/${id}`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  } catch {
    return { kind: "error", message: "連不上本機伺服器。" };
  }
  const data = await json(res);
  if (res.status === 403) return { kind: "stale" };
  if (res.status === 428) return { kind: "need", need: data.need === "typed" ? "typed" : "confirm", ...(typeof data.target === "string" ? { target: data.target } : {}) };
  if (res.status === 400) return { kind: "invalid", error: String(data.error ?? "輸入不對。"), ...(typeof data.field === "string" ? { field: data.field } : {}) };
  const malformed: CommandResult = { kind: "error", message: "伺服器回應格式不對。" };
  if (res.status === 202) {
    return typeof data.jobId === "string" && typeof data.pid === "number" ? { kind: "job", job: { jobId: data.jobId, pid: data.pid } } : malformed;
  }
  if (res.status === 200) {
    const ok =
      data.mode === "short" &&
      (data.exit === null || typeof data.exit === "number") &&
      typeof data.stdout === "string" &&
      typeof data.stderr === "string" &&
      typeof data.timedOut === "boolean";
    if (!ok) return malformed;
    return {
      kind: "short",
      result: {
        mode: "short",
        exit: data.exit as number | null,
        signal: typeof data.signal === "string" ? data.signal : null,
        stdout: data.stdout as string,
        stderr: data.stderr as string,
        timedOut: data.timedOut as boolean,
        truncated: data.truncated === true,
      },
    };
  }
  return { kind: "error", message: String(data.error ?? `伺服器回了 ${res.status}。`) };
}

export async function getJobs(): Promise<JobSummary[]> {
  try {
    const res = await fetch("/api/jobs");
    return res.ok ? (((await res.json()) as { jobs: JobSummary[] }).jobs ?? []) : [];
  } catch {
    return [];
  }
}

export async function getJob(id: string): Promise<JobDetail | undefined> {
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(id)}`);
    return res.ok ? ((await res.json()) as JobDetail) : undefined;
  } catch {
    return undefined;
  }
}

export async function getAsk(project: string, run: string): Promise<AskView | undefined> {
  try {
    const res = await fetch(`/api/ask?project=${encodeURIComponent(project)}&run=${encodeURIComponent(run)}`);
    return res.ok ? ((await res.json()) as AskView) : undefined;
  } catch {
    return undefined;
  }
}

export async function postAnswers(project: string, run: string, answers: Record<string, string>, assumeDefaults: boolean): Promise<{ complete: boolean; problems: string[] } | undefined> {
  const generic = { complete: false, problems: ["送出答案失敗，請稍後再試。"] };
  try {
    const res = await fetch("/api/ask/answers", { method: "POST", headers: headers(), body: JSON.stringify({ project, run, answers, assumeDefaults }) });
    const data = await json(res);
    if (res.ok) {
      return typeof data.complete === "boolean" && Array.isArray(data.problems) ? { complete: data.complete, problems: data.problems.map(String) } : generic;
    }
    if (Array.isArray(data.problems) && data.problems.length > 0 && data.problems.every((p) => typeof p === "string")) return { complete: false, problems: data.problems as string[] };
    if (typeof data.error === "string" && data.error) return { complete: false, problems: [data.error] };
    return generic;
  } catch {
    return generic;
  }
}
