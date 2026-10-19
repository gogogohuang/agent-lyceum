// Run under tsx. Usage: exit-hook.mjs <pidFile> <how: exit | throw>
// Starts a live runtime (process-tree.mjs "escape") through runInvocation, then dies the hard way.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInvocation } from "../../../src/process-runner.ts";

const [pidFile, how] = process.argv.slice(2);
const tree = path.join(path.dirname(fileURLToPath(import.meta.url)), "process-tree.mjs");
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "exit-hook-"));
void runInvocation(
  { cmd: process.execPath, args: [tree, "escape", pidFile], stdin: "", cwd: os.tmpdir(), parse: () => ({ ok: true, text: "" }) },
  { timeoutSec: 60, logDir },
);
const t = setInterval(() => {
  if (!fs.existsSync(pidFile) || fs.readFileSync(pidFile, "utf8") === "") return;
  clearInterval(t);
  fs.writeFileSync(pidFile + ".runtime", "ready");
  setTimeout(() => {
    if (how === "throw") throw new Error("boom");
    process.exit(3);
  }, 150);
}, 25);
