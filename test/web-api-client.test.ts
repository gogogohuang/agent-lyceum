import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postAnswers, postCommand } from "../web/src/client/api.js";

function reply(status: number, body: unknown, raw = false): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(raw ? (body as string) : JSON.stringify(body), { status })));
}

beforeEach(() => {
  vi.stubGlobal("document", { querySelector: () => ({ getAttribute: () => "tok" }) });
});
afterEach(() => vi.unstubAllGlobals());

describe("postCommand", () => {
  it("accepts a well-formed 200 and 202", async () => {
    reply(200, { mode: "short", exit: 0, stdout: "ok", stderr: "", timedOut: false });
    expect(await postCommand("doctor", {})).toEqual({
      kind: "short",
      result: { mode: "short", exit: 0, signal: null, stdout: "ok", stderr: "", timedOut: false, truncated: false },
    });
    reply(202, { jobId: "j1", pid: 42 });
    expect(await postCommand("run", {})).toEqual({ kind: "job", job: { jobId: "j1", pid: 42 } });
  });
  it("rejects malformed 200 and 202 bodies", async () => {
    reply(200, {});
    expect((await postCommand("doctor", {})).kind).toBe("error");
    reply(202, {});
    expect(await postCommand("run", {})).toEqual({ kind: "error", message: "伺服器回應格式不對。" });
  });
  it("maps 428, 403, 400 and non-JSON bodies", async () => {
    reply(428, { need: "typed", target: "web" });
    expect(await postCommand("clear", {})).toEqual({ kind: "need", need: "typed", target: "web" });
    reply(403, { error: "x" });
    expect((await postCommand("clear", {})).kind).toBe("stale");
    reply(400, { error: "任務必填。", field: "task" });
    expect(await postCommand("run", {})).toEqual({ kind: "invalid", error: "任務必填。", field: "task" });
    reply(500, "<html>oops</html>", true);
    expect(await postCommand("run", {})).toEqual({ kind: "error", message: "伺服器回了 500。" });
  });
  it("turns a fetch rejection into an error result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));
    expect((await postCommand("run", {})).kind).toBe("error");
  });
});

describe("postAnswers", () => {
  it("surfaces the server error text on a non-OK response", async () => {
    reply(400, { error: "x" });
    expect(await postAnswers("p", "r", {}, false)).toEqual({ complete: false, problems: ["x"] });
  });
  it("prefers a problems array when present", async () => {
    reply(409, { problems: ["a", "b"] });
    expect(await postAnswers("p", "r", {}, false)).toEqual({ complete: false, problems: ["a", "b"] });
  });
  it("passes a complete answer through", async () => {
    reply(200, { complete: true, problems: [] });
    expect(await postAnswers("p", "r", {}, false)).toEqual({ complete: true, problems: [] });
  });
  it("falls back to a generic problem on rejection or an opaque failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("down"))));
    const r = await postAnswers("p", "r", {}, false);
    expect(r?.complete).toBe(false);
    expect(r?.problems).toHaveLength(1);
    reply(500, "nope", true);
    expect((await postAnswers("p", "r", {}, false))?.complete).toBe(false);
  });
});
