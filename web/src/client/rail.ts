import type { WatchFrame } from "../types";
import { focusReport, runLabel } from "./view";

export function railText(frame: WatchFrame): string {
  if (frame.error) return "讀不到";
  const run = focusReport(frame)?.run;
  if (!run) return "閒置";
  const active = Object.keys(run.active);
  const who = run.state === "running" && active.length > 0 ? ` ${active.join(" ")}` : "";
  return `${runLabel(run)}${who}`;
}

export function headline(live: "up" | "down", count: number): string {
  if (live === "down") return "正在連上本機狀態…";
  if (count === 0) return "還沒有已註冊的專案。用 agent-lyceum project add 註冊一個。";
  return "選一個專案。";
}
