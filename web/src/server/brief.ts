import type { Agent, Run, StatusReport, WatchFrame } from "../types.js";

const INSTRUCTION = "用繁體中文寫這次任務現在的進度。最多三段，每段最多兩句。說明做到哪、誰正在做、卡在哪。沒有卡住就不要寫卡在哪。不要標題，不要條列，不要建議下一步。";

/** The CLI the project's lead already runs on. */
export function leadCli(agents: Agent[]): "claude" | "codex" | undefined {
  const lead = agents.find((agent) => agent.lead);
  if (lead?.runtime === "claude-code") return "claude";
  if (lead?.runtime === "codex") return "codex";
  return undefined;
}

/** The task currently on screen, from the latest watch frame. */
export function runReport(frame: WatchFrame, runId: string): StatusReport | undefined {
  const listed = Object.values(frame.runs ?? {}).find((report) => report.run?.run_id === runId);
  if (listed?.run) return listed;
  if (frame.report?.run?.run_id === runId) return frame.report;
  return undefined;
}

/** What the model is asked to read, then the instruction for how to write it. */
export function progressPrompt(report: StatusReport): string {
  return `${INSTRUCTION}\n\n${progressBrief(report)}`;
}

function progressBrief(report: StatusReport): string {
  const run = report.run;
  if (!run) return "";
  const lines = [
    `任務：${clip(run.task_summary || run.name || run.run_id, 400)}`,
    `狀態：${stateText(run)}`,
    `輪次：${run.max_rounds > 0 ? `${run.rounds}/${run.max_rounds}` : String(run.rounds)}`,
  ];
  const steps = run.steps ?? [];
  if (steps.length) lines.push(`進度：${steps.filter((step) => step.done).length}/${steps.length} 步`);
  if (run.current_step) lines.push(`目前：${clip(run.current_step, 200)}`);
  if (steps.length) {
    lines.push("步驟：");
    for (const step of steps.slice(0, 20)) lines.push(`${step.done ? "完成" : "未完成"} ${clip(step.text, 160)}`);
  }
  const active = Object.entries(run.active ?? {});
  if (run.state === "running" && active.length) {
    lines.push("正在做：");
    for (const [agent, info] of active) {
      const job = (info.handling ?? []).map((mail) => clip(mail.subject, 120)).filter(Boolean).join("；");
      lines.push(job ? `${agent}：${job}` : agent);
    }
  }
  const queue = (run.queue ?? []).slice(0, 8);
  if (queue.length) {
    lines.push("佇列：");
    for (const mail of queue) lines.push(`${mail.agent}：${clip(mail.subject, 120)}`);
  }
  if (run.failure) lines.push(`失敗：${run.failure.agent} 連續失敗 ${run.failure.attempts} 次${run.failure.error ? `。${clip(run.failure.error, 240)}` : ""}`);
  for (const item of (run.blocked_integrations ?? []).slice(0, 5)) lines.push(`受阻：${item.agent} ${clip(item.branch, 80)}。${clip(item.reason, 200)}`);
  if (run.ask && run.ask.unanswered > 0) lines.push(`等待回答：${run.ask.unanswered}/${run.ask.total}`);
  for (const note of (run.notes ?? []).slice(-3)) lines.push(`備註：${clip(note, 200)}`);
  for (const line of (run.result_head ?? []).slice(0, 6)) lines.push(`結果：${clip(line, 200)}`);
  return lines.join("\n");
}

function stateText(run: Run): string {
  if (run.state === "running") return run.live === false ? "執行中，程序已不存在" : "執行中";
  if (run.state === "interrupted") return "已中斷";
  if (run.state === "waiting") return "等待回答";
  if (!run.outcome_verified) return run.end_reason === "done" ? "完成（未驗證）" : `結束：${run.end_reason ?? "?"}`;
  const outcome: Record<string, string> = { completed: "完成", partial: "部分完成", blocked: "受阻", failed: "失敗", cancelled: "已取消" };
  return outcome[run.outcome ?? ""] ?? run.outcome ?? "結束";
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
