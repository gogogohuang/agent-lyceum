import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { codeFingerprint, watchCodeChange, WATCH_RESTART_MESSAGE } from "../src/code-change.js";
import { isWatchRestart, WATCH_RESTART_PREFIX } from "../plugins/status-monitor/hooks/watch-restart.js";

it("fingerprints nested code, sizes and mtimes, ignoring other extensions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "code-change-"));
  try {
    fs.mkdirSync(path.join(dir, "nested"));
    const file = path.join(dir, "nested/a.js");
    fs.writeFileSync(file, "a");
    const first = codeFingerprint(dir, ".js");
    expect(codeFingerprint(dir, ".js")).toBe(first);
    fs.writeFileSync(path.join(dir, "ignored.ts"), "ignored");
    expect(codeFingerprint(dir, ".js")).toBe(first);
    fs.writeFileSync(file, "longer");
    const second = codeFingerprint(dir, ".js");
    expect(second).not.toBe(first);
    fs.utimesSync(file, 1, 1);
    expect(codeFingerprint(dir, ".js")).not.toBe(second);
    expect(codeFingerprint(path.join(dir, "missing"), ".js")).toBe("");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
it("debounces each change, empty reads and a second mid-build replacement", () => {
  let value = "initial";
  const changed = watchCodeChange(() => value);
  expect(changed()).toBe(false);
  value = "A";
  expect(changed()).toBe(false);
  expect(changed()).toBe(true);
  const replacement = watchCodeChange(() => value);
  value = "B";
  expect(replacement()).toBe(false);
  expect(replacement()).toBe(true);
  value = "";
  expect(changed()).toBe(false);
  expect(changed()).toBe(false);
});
it("agrees with the plugin marker prefix", () => {
  expect(WATCH_RESTART_MESSAGE.startsWith(WATCH_RESTART_PREFIX)).toBe(true);
  expect(isWatchRestart(WATCH_RESTART_MESSAGE)).toBe(true);
  expect(isWatchRestart("status --watch ended")).toBe(false);
});
