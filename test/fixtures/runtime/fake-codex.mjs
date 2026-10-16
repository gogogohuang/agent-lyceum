// A stand-in for the `codex` CLI, as small as the fallback tests need: `codex exec ... -o <file> -` reads the prompt from stdin,
// writes the last message to <file> and prints JSON events.
//
// FAKE_FAIL=<kind>[:<times>]   fail like the real CLI does for that error kind (rate_limit | quota | network | auth | unknown | crash | timeout):
//                              the first <times> calls fail (counted in FAKE_FAIL_COUNT=<file>), then calls succeed; no <times> = always fail.
// FAKE_SCRIPT=<file.json>      { "calls": [ { fail?, result? } ... ] }: call N (counted in <file>.count) does what entry N says.
import { spawn } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli 0.162.1 (fake)");
  process.exit(0);
}
fs.readFileSync(0, "utf8");

// kind -> message of the final `turn.failed` event. auth and network are real captured output; the others follow the documented text.
const FAILURES = {
  auth: "unexpected status 401 Unauthorized: Incorrect API key provided: sk-bogus. You can find your API key at https://platform.openai.com/account/api-keys., url: https://api.openai.com/v1/responses, auth error: 401, auth error code: invalid_api_key",
  network: "Reconnecting... waiting for network (Connection failed: error sending request)",
  rate_limit: "exceeded retry limit, last status: 429 Too Many Requests",
  quota: "You've hit your usage limit. Upgrade to Pro or try again later.",
  unknown: "something unexpected happened",
};
const ev = (e) => console.log(JSON.stringify(e));
const sleepForever = () => {
  const gc = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "inherit" });
  if (process.env.FAKE_MARKER) fs.writeFileSync(process.env.FAKE_MARKER, JSON.stringify({ pid: process.pid, grandchild: gc.pid }));
  setInterval(() => {}, 1000);
};
const fail = (kind) => {
  if (kind === "crash") process.kill(process.pid, "SIGKILL");
  else if (kind === "timeout") sleepForever();
  else if (!FAILURES[kind]) {
    console.error(`fake codex: unknown FAKE_FAIL kind "${kind}"`);
    process.exit(2);
  } else {
    ev({ type: "thread.started", thread_id: "t" });
    ev({ type: "turn.started" });
    if (kind === "network") ev({ type: "error", message: FAILURES[kind] });
    ev({ type: "turn.failed", error: { message: kind === "network" ? "stream disconnected before completion: error sending request" : FAILURES[kind] } });
    process.exit(1);
  }
};
const succeed = (text = "ok") => {
  const out = args[args.indexOf("-o") + 1];
  if (out && args.includes("-o")) fs.writeFileSync(out, text);
  ev({ type: "thread.started", thread_id: "t" });
  ev({ type: "turn.completed", usage: { output_tokens: 1 } });
};

const [failKind, failTimes] = (process.env.FAKE_FAIL ?? "").split(":");
let failing = Boolean(failKind);
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
    console.error(`fake codex: no scripted call #${n}`);
    process.exit(1);
  }
  if (step.fail) fail(step.fail);
  else succeed(step.result);
} else succeed();
