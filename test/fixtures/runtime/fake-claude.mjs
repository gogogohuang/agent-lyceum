// A stand-in for the `claude` CLI.
//
// FAKE_MODE=completed | sleep            simple one-shot behaviours (the lead sends a full `done`, or hangs)
// FAKE_SCRIPT=<file.json>                a script: { "calls": [ { agent, sleep?, writes?, writeAbs?, mail? } ... ] }
//                                        call N of the whole run (counted in <file>.count) does what entry N says.
// moveAbs: [{ from, to }]   rename files by absolute path; "{ARCHIVE}" in any path/content is the "Archive directory:" line of a memory-tidy prompt
// FAKE_MARKER=<file>                     written when a sleeping call starts: { pid, grandchild }
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
  const gc = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "inherit" });
  if (process.env.FAKE_MARKER) fs.writeFileSync(process.env.FAKE_MARKER, JSON.stringify({ pid: process.pid, grandchild: gc.pid }));
  setInterval(() => {}, 1000);
};
const sendMail = (m) => {
  const fm = [`to: ${m.to ?? "lead"}`, `type: ${m.type ?? "reply"}`, `subject: ${m.subject ?? "re"}`, ...(m.outcome ? [`outcome: ${m.outcome}`] : [])].join("\n");
  const body = m.body ?? (m.type === "done" ? FULL : "## Changes\n- done\n\n## Verification\nok\n\n## Open items\nNone\n\n## Risks\nNone\n");
  fs.writeFileSync(path.join(outbox, `m${Date.now()}-${Math.random().toString(16).slice(2)}.md`), `---\n${fm}\n---\n\n${body}\n`);
};
const finish = () => process.stdout.write(JSON.stringify({ result: "ok", session_id: "s", usage: { output_tokens: 1 } }));

if (process.env.FAKE_SCRIPT) {
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
  for (const [abs, content] of Object.entries(step.writeAbs ?? {})) {
    fs.mkdirSync(path.dirname(sub(abs)), { recursive: true });
    fs.writeFileSync(sub(abs), sub(content));
  }
  if (step.sleep) sleepForever();
  else {
    for (const m of step.mail ?? []) sendMail(m);
    finish();
  }
} else if (process.env.FAKE_MODE === "sleep") sleepForever();
else {
  if (process.env.FAKE_MODE === "completed" && outbox) sendMail({ to: "lead", type: "done", subject: "r", outcome: "completed" });
  finish();
}
