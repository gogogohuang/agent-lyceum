// A stand-in for the `claude` CLI. FAKE_MODE: completed | sleep. Writes mail into the outbox it was given via --add-dir.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const dirs = args.flatMap((x, i) => (x === "--add-dir" ? [args[i + 1]] : []));
const outbox = dirs.find((d) => d.endsWith(path.join("outbox", process.env.AGENT_TEAM_AGENT ?? "")));
fs.readFileSync(0);
const mode = process.env.FAKE_MODE;
const full = "## Result\nok\n\n## Files\n- a\n\n## Verification\nran tests\n\n## Not done\nNone\n";

if (mode === "sleep") {
  const gc = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "inherit" });
  if (process.env.FAKE_MARKER) fs.writeFileSync(process.env.FAKE_MARKER, JSON.stringify({ pid: process.pid, grandchild: gc.pid }));
  setInterval(() => {}, 1000);
} else {
  if (mode === "completed" && outbox) fs.writeFileSync(path.join(outbox, `m${Date.now()}.md`), `---\ntype: done\nsubject: r\noutcome: completed\n---\n\n${full}\n`);
  process.stdout.write(JSON.stringify({ result: "ok", session_id: "s", usage: { output_tokens: 1 } }));
}
