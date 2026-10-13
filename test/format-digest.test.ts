import { describe, expect, it } from "vitest";
import { digestOf } from "../src/format.js";

describe("digestOf", () => {
  it("task: Goal and Acceptance criteria, markdown stripped, long lists cut at 3 lines", () => {
    const body = [
      "## Goal",
      "實作登入頁 UI 與表單驗證。",
      "",
      "## Acceptance criteria",
      "- 路由 /login 可開啟",
      "- 驗證失敗時顯示欄位錯誤訊息",
      "- 送出時呼叫 **auth.login**",
      "- 第四行",
      "",
      "## Scope",
      "src/web/**",
      "",
      "## Upstream",
      "a1b2c3",
    ].join("\n");
    expect(digestOf("task", body)).toEqual([
      { label: "目標", lines: ["實作登入頁 UI 與表單驗證。"] },
      { label: "驗收", lines: ["路由 /login 可開啟", "驗證失敗時顯示欄位錯誤訊息", "送出時呼叫 auth.login…"] },
    ]);
  });

  it("reply: Changes and Verification; Open items and Risks only when not None", () => {
    const quiet = "## Changes\n- 新增 `src/web/login.tsx`\n\n## Verification\n- tsc --noEmit 通過\n\n## Open items\nNone\n\n## Risks\nNone.";
    expect(digestOf("reply", quiet)).toEqual([
      { label: "變更", lines: ["新增 src/web/login.tsx"] },
      { label: "驗證", lines: ["tsc --noEmit 通過"] },
    ]);
    const risky = "## Changes\n- a\n\n## Verification\n- b\n\n## Open items\n- 尚未接真實 API\n\n## Risks\nNone";
    expect(digestOf("reply", risky).map((s) => s.label)).toEqual(["變更", "驗證", "待辦"]);
  });

  it("done: Result and Not done", () => {
    const body = "## Result\n登入頁已完成。\n\n## Files\n- a\n\n## Not done\n- 未做 e2e\n- [ ] 未 commit";
    expect(digestOf("done", body)).toEqual([
      { label: "結果", lines: ["登入頁已完成。"] },
      { label: "未完成", lines: ["未做 e2e", "未 commit"] },
    ]);
  });

  it("ask: one section per question, labelled with its id", () => {
    const body = '<ask>\n  <question id="q1">\n    <text>登入要用 session 還是 JWT？</text>\n  </question>\n  <question id="q2" extra="x">\n    <text>要不要支援舊版 API？</text>\n  </question>\n</ask>';
    expect(digestOf("ask", body)).toEqual([
      { label: "q1", lines: ["登入要用 session 還是 JWT？"] },
      { label: "q2", lines: ["要不要支援舊版 API？"] },
    ]);
  });

  it("failure: the first paragraph", () => {
    const body = "Your outbox message `plan-ui.md` was not delivered: you may only message: lead.\nIt was moved to `rejected/`.\n\nSecond paragraph.";
    expect(digestOf("failure", body)).toEqual([
      { label: "訊息", lines: ["Your outbox message plan-ui.md was not delivered: you may only message: lead.", "It was moved to rejected/."] },
    ]);
  });

  it("keeps a bullet that starts with #, drops real headings", () => {
    const [s] = digestOf("reply", "## Changes\n- #123 login fixed\n### Sub\n- b");
    expect(s?.lines).toEqual(["#123 login fixed", "b"]);
  });

  it("falls back to the one-line brief, then to nothing", () => {
    expect(digestOf("reply", "# Title\n\nJust text")).toEqual([{ label: "摘要", lines: ["Just text"] }]);
    expect(digestOf("task", "")).toEqual([]);
    expect(digestOf("whatever", "## Goal\nx")).toEqual([{ label: "摘要", lines: ["x"] }]);
  });

  it("caps a line at 80 characters", () => {
    const [s] = digestOf("task", `## Goal\n${"字".repeat(100)}`);
    expect(s?.lines[0]).toHaveLength(80);
    expect(s?.lines[0]?.endsWith("…")).toBe(true);
  });

  it("keeps a truncated 3rd line within 80 characters", () => {
    const body = `## Acceptance criteria\n- a\n- b\n- ${"字".repeat(100)}\n- 第四行`;
    const [s] = digestOf("task", body);
    expect(s?.lines).toHaveLength(3);
    for (const l of s?.lines ?? []) expect(l.length).toBeLessThanOrEqual(80);
    expect(s?.lines[2]?.endsWith("…")).toBe(true);
    expect(s?.lines[2]?.endsWith("……")).toBe(false);
  });

  it("skips the dispatcher's format warning", () => {
    expect(digestOf("task", "[agent-lyceum] Format warning: x\n\n## Goal\nShip it")).toEqual([{ label: "目標", lines: ["Ship it"] }]);
  });
});
