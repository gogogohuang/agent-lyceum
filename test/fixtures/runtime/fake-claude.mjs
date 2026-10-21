// A stand-in for the `claude` CLI.
//
// FAKE_MODE=completed | sleep            simple one-shot behaviours (the lead sends a full `done`, or hangs)
// FAKE_SCRIPT=<file.json>                a script: { "calls": [ { agent, sleep?, writes?, writeAbs?, writeLead?, mail?, result? } ... ] }
//                                        call N of the whole run (counted in <file>.count) does what entry N says.
// moveAbs: [{ from, to }]   rename files by absolute path; "{ARCHIVE}" in any path/content is the "Archive directory:" line of a memory-tidy prompt
// FAKE_FAIL=<kind>[:<times>]             fail like the real CLI does for that error kind (rate_limit | quota | network | auth | unknown | crash | timeout):
//                                        the first <times> calls fail (counted in FAKE_FAIL_COUNT=<file>, required with <times>), then calls behave as below; no <times> = always fail.
//                                        A script entry can say `fail: "<kind>"` instead (it is counted by the script itself).
// FAKE_MARKER=<file>                     written when a sleeping call starts: { pid, grandchild }
// FAKE_IGNORE_TERM=1                     a sleeping call ignores SIGTERM (it only dies on SIGKILL, after the kill grace)
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("2.1.9 (Claude Code, fake)");
  process.exit(0);
}
if (args[0] === "--help") {
  console.log("  --output-format <f>\n  --resume [id]\n  --settings <file>\n  --effort <level>");
  process.exit(0);
}
const prompt = fs.readFileSync(0, "utf8");

const me = process.env.AGENT_LYCEUM_AGENT ?? "";
const dirs = args.flatMap((x, i) => (x === "--add-dir" ? [args[i + 1]] : []));
const outbox = dirs.find((d) => d.endsWith(path.join("outbox", me)));
const FULL = "## Result\nok\n\n## Files\n- a\n\n## Verification\nran tests\n\n## Not done\nNone\n";

const sleepForever = () => {
  if (process.env.FAKE_IGNORE_TERM) process.on("SIGTERM", () => {});
  const gc = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "inherit" });
  if (process.env.FAKE_MARKER) fs.writeFileSync(process.env.FAKE_MARKER, JSON.stringify({ pid: process.pid, grandchild: gc.pid }));
  setInterval(() => {}, 1000);
};
const sendMail = (m) => {
  const fm = [`to: ${m.to ?? "lead"}`, `type: ${m.type ?? "reply"}`, `subject: ${m.subject ?? "re"}`, ...(m.outcome ? [`outcome: ${m.outcome}`] : [])].join("\n");
  const body = m.body ?? (m.type === "done" ? FULL : m.type === "task" ? "## Goal\nx\n\n## Acceptance criteria\nNone\n\n## Scope\nNone\n\n## Upstream\nNone\n" : "## Changes\n- done\n\n## Verification\nok\n\n## Open items\nNone\n\n## Risks\nNone\n");
  fs.writeFileSync(path.join(outbox, `m${Date.now()}-${Math.random().toString(16).slice(2)}.md`), `---\n${fm}\n---\n\n${body}\n`);
};
// kind -> [exit code, stdout result message, api_error_status, stderr]. auth and network are real captured output; the others follow the documented text.
const FAILURES = {
  auth: [1, "Invalid API key · Fix external API key", 401, ""],
  network: [1, "API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)", null, ""],
  rate_limit: [1, "API Error: Request rejected (429) · rate_limit_error", 429, ""],
  quota: [1, "5-hour limit reached ∙ resets 3pm", null, ""],
  unknown: [1, "", null, "fake claude: something unexpected happened"],
};
const fail = (kind) => {
  if (kind === "crash") process.kill(process.pid, "SIGKILL");
  else if (kind === "timeout") return sleepForever();
  else if (!FAILURES[kind]) {
    console.error(`fake claude: unknown FAKE_FAIL kind "${kind}"`);
    process.exit(2);
  } else {
    const [code, result, status, err] = FAILURES[kind];
    if (err) console.error(err);
    else process.stdout.write(JSON.stringify({ type: "result", is_error: true, api_error_status: status, result, session_id: "s", usage: { output_tokens: 0 } }));
    process.exit(code);
  }
};
const finish = (text = "ok") => process.stdout.write(JSON.stringify({ result: text, session_id: "s", usage: { output_tokens: 1 } }));

const [failKind, failTimes] = (process.env.FAKE_FAIL ?? "").split(":");
let failing = Boolean(failKind);
if (failing && failTimes && !process.env.FAKE_FAIL_COUNT) {
  console.error("fake claude: FAKE_FAIL=<kind>:<times> needs FAKE_FAIL_COUNT=<file> to count calls");
  process.exit(2);
}
if (failing && failTimes && process.env.FAKE_FAIL_COUNT) {
  const countFile = process.env.FAKE_FAIL_COUNT;
  const seen = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;
  fs.writeFileSync(countFile, String(seen + 1));
  failing = seen < Number(failTimes);
}
if (failing) fail(failKind);
else if (process.env.FAKE_SCRIPT) {
  const file = process.env.FAKE_SCRIPT;
  const countFile = `${file}.count`;
  const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;
  fs.writeFileSync(countFile, String(n + 1));
  const step = JSON.parse(fs.readFileSync(file, "utf8")).calls[n];
  if (!step) {
    console.error(`fake claude: no scripted call #${n} (agent ${me})`);
    process.exit(1);
  }
  if (step.agent !== me) {
    console.error(`fake claude: call #${n} is scripted for ${step.agent}, but ${me} was woken`);
    process.exit(1);
  }
  if (step.fail === "timeout") step.sleep = true; // a hang is what a timeout looks like from outside
  else if (step.fail) fail(step.fail);
  const archive = /^Archive directory: (.+)$/m.exec(prompt)?.[1] ?? "";
  const sub = (x) => x.replaceAll("{ARCHIVE}", archive);
  for (const m of step.moveAbs ?? []) {
    fs.mkdirSync(path.dirname(sub(m.to)), { recursive: true });
    fs.renameSync(sub(m.from), sub(m.to));
  }
  for (const [rel, content] of Object.entries(step.writes ?? {})) {
    fs.mkdirSync(path.dirname(path.join(process.cwd(), rel)), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), rel), content);
  }
  // `writeLead`: files in the lead's worktree, a sibling of this member's (<home>/worktrees/<run>/lead): a concurrent edit by the lead.
  for (const [rel, content] of Object.entries(step.writeLead ?? {})) {
    const to = path.join(process.cwd(), "..", "lead", rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, content);
  }
  for (const [abs, content] of Object.entries(step.writeAbs ?? {})) {
    fs.mkdirSync(path.dirname(sub(abs)), { recursive: true });
    fs.writeFileSync(sub(abs), sub(content));
  }
  if (step.sleep) sleepForever();
  else {
    for (const m of step.mail ?? []) sendMail(m);
    finish(step.result);
  }
} else if (process.env.FAKE_MODE === "sleep") sleepForever();
else {
  if (process.env.FAKE_MODE === "completed" && outbox) sendMail({ to: "lead", type: "done", subject: "r", outcome: "completed" });
  finish();
}
