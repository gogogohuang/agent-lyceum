import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouteJournal } from "../src/message-store.js";

// Spec 23.8.1 (D-18): a journal line cut short by a crash must not swallow the next record, and a short write must not look like success.

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-tail-"));
  fs.mkdirSync(path.join(dir, "mail"));
  file = path.join(dir, "mail", "journal.jsonl");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const entry = (source: string, to = "fe") => ({ source, to, msg_id: `id-${source}`, file: `f-${source}.md`, created: "2026-01-01T00:00:00.000Z" });
const line = (o: object) => `${JSON.stringify(o)}\n`;
const intentLine = (e: ReturnType<typeof entry>) => line({ t: "intent", ...e });

describe("RouteJournal append: torn tail (D-18)", () => {
  it("T-R2-1: an intent appended after a line cut short is still there after a restart", () => {
    fs.writeFileSync(file, `${intentLine(entry("old"))}{"t":"assign","msg_id":"cut`);
    new RouteJournal(dir).intent(entry("new"));
    const again = new RouteJournal(dir);
    expect(again.get("new", "fe")?.msg_id).toBe("id-new");
    expect(again.get("old", "fe")?.msg_id).toBe("id-old");
    expect(fs.readFileSync(file, "utf8")).toBe(`${intentLine(entry("old"))}{"t":"assign","msg_id":"cut\n${intentLine(entry("new"))}`);
  });

  it("T-R2-2: a last line that is whole JSON but lacks its newline keeps its record, and so does the new one", () => {
    fs.writeFileSync(file, intentLine(entry("a")).trimEnd());
    const j = new RouteJournal(dir);
    expect(j.get("a", "fe")).toBeDefined(); // the reader already accepts it
    j.delivered("a", "fe");
    const again = new RouteJournal(dir);
    expect(again.get("a", "fe")?.delivered).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe(`${intentLine(entry("a"))}${line({ t: "delivered", source: "a", to: "fe" })}`);
  });

  it("T-R2-3: a well-formed, empty or missing journal gets exactly the bytes it always got", () => {
    const old = intentLine(entry("a"));
    fs.writeFileSync(file, old);
    new RouteJournal(dir).intent(entry("b"));
    expect(fs.readFileSync(file, "utf8")).toBe(old + intentLine(entry("b")));
    fs.writeFileSync(file, "");
    new RouteJournal(dir).intent(entry("c"));
    expect(fs.readFileSync(file, "utf8")).toBe(intentLine(entry("c")));
    fs.rmSync(file);
    new RouteJournal(dir).intent(entry("d"));
    expect(fs.readFileSync(file, "utf8")).toBe(intentLine(entry("d")));
  });

  it("checks the tail once per journal object: its own appends are not padded", () => {
    fs.writeFileSync(file, "{cut");
    const j = new RouteJournal(dir);
    j.intent(entry("a"));
    j.delivered("a", "fe");
    j.intent(entry("b"));
    expect(fs.readFileSync(file, "utf8")).toBe(`{cut\n${intentLine(entry("a"))}${line({ t: "delivered", source: "a", to: "fe" })}${intentLine(entry("b"))}`);
  });

  it("T-R2-4: a short write throws, names the file, and leaves the in-memory index without the record", () => {
    fs.writeFileSync(file, intentLine(entry("a")));
    const j = new RouteJournal(dir);
    const real = fs.writeSync;
    vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, data: unknown, ...rest: unknown[]) => real(fd, (data as Buffer).subarray(0, 10), ...(rest as []))) as typeof fs.writeSync);
    expect(() => j.intent(entry("b"))).toThrow(/journal\.jsonl/);
    expect(j.get("b", "fe")).toBeUndefined();
    vi.restoreAllMocks();
    // the 10 bytes that did land are a torn line: the next append (even from this same object) pads it, and nothing is lost
    j.intent(entry("c"));
    const again = new RouteJournal(dir);
    expect(again.get("c", "fe")).toBeDefined();
    expect(again.get("a", "fe")).toBeDefined();
    expect(again.get("b", "fe")).toBeUndefined();
  });
});

describe("RouteJournal append: the tail is checked on every append (review 0708f19f)", () => {
  const shortWrite = () => {
    const real = fs.writeSync;
    return vi.spyOn(fs, "writeSync").mockImplementation(((fd: number, data: unknown, ...rest: unknown[]) => real(fd, (data as Buffer).subarray(0, 10), ...(rest as []))) as typeof fs.writeSync);
  };
  it("success, then a short write, then success: the last record survives a restart", () => {
    const j = new RouteJournal(dir);
    j.intent(entry("a"));
    shortWrite();
    expect(() => j.intent(entry("b"))).toThrow(/journal\.jsonl/);
    vi.restoreAllMocks();
    j.intent(entry("c"));
    const again = new RouteJournal(dir);
    expect(again.get("a", "fe")).toBeDefined();
    expect(again.get("c", "fe")).toBeDefined();
  });
  it("two objects on one file: a partial append by one does not swallow the other's next record", () => {
    const x = new RouteJournal(dir);
    const y = new RouteJournal(dir);
    x.intent(entry("x1"));
    y.intent(entry("y1"));
    shortWrite();
    expect(() => x.intent(entry("x2"))).toThrow();
    vi.restoreAllMocks();
    y.intent(entry("y2"));
    const again = new RouteJournal(dir);
    for (const s of ["x1", "y1", "y2"]) expect(again.get(s, "fe")).toBeDefined();
  });
});
