import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunLog } from "../src/run-log.js";

let dir: string;
const lines = (f: string) => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l));
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("createRunLog", () => {
  it("appends one JSON line per event with a timestamp", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-log-"));
    const file = path.join(dir, "log.jsonl");
    const log = createRunLog(file, 0);
    log("start", { a: 1 });
    log("end");
    const rows = lines(file);
    expect(rows.map((r) => r.event)).toEqual(["start", "end"]);
    expect(rows[0].a).toBe(1);
    expect(typeof rows[0].ts).toBe("string");
  });

  it("rotates to log.1.jsonl when the next line would pass the limit, without losing or repeating events", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-log-"));
    const file = path.join(dir, "log.jsonl");
    const log = createRunLog(file, 300);
    for (let i = 0; i < 12; i++) log("e", { i, pad: "x".repeat(40) });
    const old = lines(path.join(dir, "log.1.jsonl")).map((r) => r.i);
    const cur = lines(file).map((r) => r.i);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(300);
    // only one older file is kept, so the tail of the sequence is contiguous across the two files
    const all = [...old, ...cur];
    expect(all).toEqual(Array.from({ length: all.length }, (_, k) => 12 - all.length + k));
    expect(cur.at(-1)).toBe(11);
  });

  it("never rotates when the limit is 0", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-log-"));
    const file = path.join(dir, "log.jsonl");
    const log = createRunLog(file, 0);
    for (let i = 0; i < 50; i++) log("e", { pad: "x".repeat(100) });
    expect(fs.existsSync(path.join(dir, "log.1.jsonl"))).toBe(false);
  });

  it("continues an existing file after a resume (size is read from disk)", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyceum-log-"));
    const file = path.join(dir, "log.jsonl");
    fs.writeFileSync(file, JSON.stringify({ ts: "t", event: "old", pad: "x".repeat(200) }) + "\n");
    const log = createRunLog(file, 260);
    log("new", { pad: "y".repeat(100) });
    expect(lines(path.join(dir, "log.1.jsonl"))[0].event).toBe("old");
    expect(lines(file)[0].event).toBe("new");
  });
});
