import { describe, expect, it } from "vitest";
import { confirmReady, initialState, reduce } from "../web/src/client/dialog-state.js";
import { exitInfo } from "../web/src/client/exit-info.js";

const short = { kind: "short", result: { mode: "short", exit: 0, signal: null, stdout: "ok", stderr: "", timedOut: false, truncated: false } } as const;

describe("dialog state machine", () => {
  it("form -> running -> done", () => {
    let s = reduce(initialState, { type: "submit" });
    expect(s.phase).toBe("running");
    s = reduce(s, { type: "result", result: short });
    expect(s).toEqual({ phase: "done", result: short });
  });
  it("a 428 upgrades to the confirm view and typed input gates the button", () => {
    let s = reduce(initialState, { type: "submit" });
    s = reduce(s, { type: "result", result: { kind: "need", need: "typed", target: "web" } });
    expect(s).toMatchObject({ phase: "confirm", need: "typed", target: "web", typed: "" });
    expect(confirmReady(s)).toBe(false);
    s = reduce(s, { type: "typed", value: "we" });
    expect(confirmReady(s)).toBe(false);
    s = reduce(s, { type: "typed", value: "web" });
    expect(confirmReady(s)).toBe(true);
  });
  it("a plain confirm needs no typing", () => {
    const s = reduce(reduce(initialState, { type: "submit" }), { type: "result", result: { kind: "need", need: "confirm" } });
    expect(confirmReady(s)).toBe(true);
  });
  it("a 400 returns to the form with the field error", () => {
    const s = reduce(reduce(initialState, { type: "submit" }), { type: "result", result: { kind: "invalid", error: "任務必填。", field: "task" } });
    expect(s).toEqual({ phase: "form", errors: { task: "任務必填。" } });
  });
  it("an invalid answer with no field becomes a notice", () => {
    const s = reduce(reduce(initialState, { type: "submit" }), { type: "result", result: { kind: "invalid", error: "壞了" } });
    expect(s).toEqual({ phase: "form", errors: {}, notice: "壞了" });
  });
  it("a stale token asks for a reload; a network error keeps the form", () => {
    expect(reduce(reduce(initialState, { type: "submit" }), { type: "result", result: { kind: "stale" } })).toMatchObject({ phase: "form", notice: expect.stringContaining("重新整理") });
    expect(reduce(reduce(initialState, { type: "submit" }), { type: "result", result: { kind: "error", message: "連不上" } })).toMatchObject({ phase: "form", notice: "連不上" });
  });
  it("back and reset return to a clean form", () => {
    const s = reduce(reduce(initialState, { type: "submit" }), { type: "result", result: { kind: "need", need: "confirm" } });
    expect(reduce(s, { type: "back" })).toEqual(initialState);
    expect(reduce(s, { type: "reset" })).toEqual(initialState);
  });
  it("a second submit while running is ignored", () => {
    const running = reduce(initialState, { type: "submit" });
    expect(reduce(running, { type: "submit" })).toBe(running);
  });
});

describe("exitInfo", () => {
  it("maps the documented exit codes", () => {
    expect(exitInfo(0, false)).toEqual({ tone: "ok", text: "完成" });
    expect(exitInfo(2, false).tone).toBe("warn");
    expect(exitInfo(3, false)).toEqual({ tone: "warn", text: "正在等你回答問題" });
    expect(exitInfo(1, false)).toEqual({ tone: "fail", text: "失敗（結束碼 1）" });
    expect(exitInfo(null, true)).toEqual({ tone: "fail", text: "等太久，已中止" });
    expect(exitInfo(null, false)).toEqual({ tone: "fail", text: "沒能啟動" });
  });
});
