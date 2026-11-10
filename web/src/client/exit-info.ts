export function exitInfo(exit: number | null, timedOut: boolean): { tone: "ok" | "warn" | "fail"; text: string } {
  if (timedOut) return { tone: "fail", text: "等太久，已中止" };
  if (exit === null) return { tone: "fail", text: "沒能啟動" };
  if (exit === 0) return { tone: "ok", text: "完成" };
  if (exit === 2) return { tone: "warn", text: "部分完成，或被擋住（結束碼 2）" };
  if (exit === 3) return { tone: "warn", text: "正在等你回答問題" };
  return { tone: "fail", text: `失敗（結束碼 ${exit}）` };
}
