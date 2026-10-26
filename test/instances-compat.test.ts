import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexWritableRoots } from "../src/adapters/codex.js";
import { buildClaudeSettings } from "../src/adapters/claude.js";
import { flattenResolved, resolveProjectWithSources } from "../src/config.js";
import { runTeam } from "../src/dispatcher.js";
import { outboxDir, writePolicy } from "../src/policy.js";
import { LEAD_PARALLEL_HINT } from "../src/scaffold.js";
import { PARALLEL_SECTION, buildSystemPrompt } from "../src/prompt.js";
import { bindRunProject } from "../src/run-store.js";
import { buildStatusReport } from "../src/status.js";
import { prepareTask } from "../src/task.js";
import type { WakeInput } from "../src/adapters/index.js";
import { FULL_DONE, git, initGitRepo, makeEnv, withSections, write, type TestEnv } from "./helpers.js";

vi.setConfig({ testTimeout: 30_000 }); // real git runs; the default 5 s is too tight under a loaded full suite

// Spec 23.15 / decision 6: a run in which the lead never sets `parallel` must produce the same bytes as before the feature.
// The fixtures under test/fixtures/instances were generated at HEAD (before any feature code) and must keep passing unchanged;
// the lead's system prompt is the one file that spec 23.12 (D-13) allows to gain a fixed suffix.
// Regenerate only on purpose: `UPDATE_INSTANCES_FIXTURES=1 npx vitest run test/instances-compat.test.ts`.

const FIXTURES = path.join(__dirname, "fixtures", "instances");
const NOW = Date.parse("2026-01-01T00:01:00Z");

/**
 * Replace what legitimately differs between two runs of the same scenario: the temp directory, time stamps, process ids, durations,
 * random message/claim/source ids and commit ids. Random ids become placeholders numbered by first appearance, so a changed
 * id *structure* (e.g. one id reused for two mails) is still visible. Everything else is left as is.
 */
function normalize(text: string, roots: string[]): string {
  const seen = new Map<string, string>();
  const tag = (kind: string, id: string) => {
    const key = `${kind}:${id}`;
    if (!seen.has(key)) seen.set(key, `<${kind}${[...seen.keys()].filter((k) => k.startsWith(`${kind}:`)).length + 1}>`);
    return seen.get(key) as string;
  };
  let out = text;
  for (const r of [...new Set(roots)].sort((a, b) => b.length - a.length)) out = out.split(r).join("<ROOT>");
  return out
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<ISO>")
    .replace(/\b\d{8}T\d{9}Z\b/g, "<STAMP>")
    .replace(/("pid": ?)\d+/g, "$11") // a pid is a number, so the placeholder is one too (the fixtures stay valid JSON)
    .replace(/("duration_ms": ?)\d+/g, "$11")
    .replace(/\b[0-9a-f]{40}\b/g, (m) => tag("SHA", m))
    .replace(/\b[0-9a-z]{6,9}-(lead|fe-member|qa-member|fe--x)-[0-9a-f]{6}\b/g, (m) => tag("CLAIM", m))
    .replace(/\b[0-9a-f]{16}\b/g, (m) => tag("SRC", m))
    .replace(/^((?:id|thread|reply_to|msg_id): )"([0-9a-f]{6,8})"$/gm, "$1$2") // YAML quotes an id only when it looks like a number
    // an all-digit token is an id only where ids appear (a file name, an id/thread/reply_to line, "msg_id"), not e.g. 8388608 bytes
    .replace(/\b[0-9a-f]{6,8}\b/g, (m, off: number, all: string) => (/^\d+$/.test(m) && !/(?:-|\bid: |\bthread: |\breply_to: |"msg_id":")$/.test(all.slice(Math.max(0, off - 12), off)) ? m : tag("ID", m)));
}

function fixture(name: string, text: string): void {
  const file = path.join(FIXTURES, name);
  if (process.env.UPDATE_INSTANCES_FIXTURES) {
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  expect(fs.existsSync(file), `missing fixture ${name}; generate it at HEAD with UPDATE_INSTANCES_FIXTURES=1`).toBe(true);
  expect(text, name).toBe(fs.readFileSync(file, "utf8"));
}

const OK = { ok: true, text: "", exitCode: 0, timedOut: false };
const send = (i: WakeInput, to: string, subject: string, type = "reply", extra = "") =>
  write(
    path.join(outboxDir(i.project, i.agent.name), `${subject.replace(/\W+/g, "-")}.md`),
    `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: completed\n" : ""}${extra}---\n\n${type === "done" ? FULL_DONE : withSections(type, `body of ${subject}`)}\n`,
  );

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

let env: TestEnv;
afterEach(() => env?.cleanup());

type Kind = "a" | "e" | "f";

/**
 * a: the lead sends two plain tasks to one member, which finish normally.
 * e: same, but the member's configured name contains `--` (an old project that could clash with `<role>--<k>`).
 * f: the member is blocked at integration, then the lead sends it another plain task.
 */
async function scenario(kind: Kind, extraProjectYaml = "") {
  env = makeEnv();
  // `init` now writes one more bullet into a new lead AGENT.md (spec 23.12.5); the HEAD fixtures were made without it, and this file tests the dispatcher, not the scaffold.
  const leadMd = path.join(env.home, "agents", "lead", "AGENT.md");
  fs.writeFileSync(leadMd, fs.readFileSync(leadMd, "utf8").replace(`- ${LEAD_PARALLEL_HINT}\n`, ""));
  initGitRepo(env.repo);
  const member = kind === "e" ? "fe--x" : "fe-member";
  if (kind === "e") env.editProjectYaml((t) => `${t}  fe--x:\n    runtime: claude-code\n    agent_md: ${path.join(env.home, "agents/fe-member/AGENT.md")}\n    can_message: [lead]\n`);
  if (extraProjectYaml) env.editProjectYaml(extraProjectYaml.startsWith("dispatcher:") ? (t) => t.replace("dispatcher:\n", `${extraProjectYaml}\n`) : (t) => t + extraProjectYaml);
  const project = env.project();
  const runDir = path.join(project.paths.runs, "run-1");
  const wakes: { agent: string; system: string; policy: string; claude: string; codex: string }[] = [];
  const calls: Record<string, number> = {};
  let leadDir = "";
  const summary = await runTeam({
    project,
    task: prepareTask({ text: "build it", cwd: env.root, runDir }),
    runDir,
    log: () => {},
    invoker: async (i) => {
      const n = (calls[i.agent.name] ?? 0) + 1;
      calls[i.agent.name] = n;
      wakes.push({
        agent: `${i.agent.name}#${n}`,
        system: i.systemPrompt,
        policy: JSON.stringify(writePolicy(i.project, i.agent), null, 2),
        claude: JSON.stringify(buildClaudeSettings(i.project, i.agent), null, 2),
        codex: JSON.stringify(codexWritableRoots(i), null, 2),
      });
      if (i.agent.name === "lead") {
        leadDir = i.workspace!.dir;
        if (n === 1) {
          send(i, member, "first job", "task");
          if (kind !== "f") send(i, member, "second job", "task");
        } else if (kind === "f" && n === 2) send(i, member, "retry job", "task");
        else send(i, "lead", "bye", "done");
      } else {
        if (kind === "f" && n === 1) {
          write(path.join(i.workspace!.dir, "src/web/a.txt"), "member version\n");
          write(path.join(leadDir, "src/web/a.txt"), "someone else's edit\n");
        } else write(path.join(i.workspace!.dir, `src/web/${i.agent.name}-${n}.txt`), "built\n");
        send(i, "lead", `finished ${n}`);
      }
      return OK;
    },
  });
  const roots = [env.root, fs.realpathSync(env.root)];
  const norm = (t: string) => normalize(t, roots);
  const bound = bindRunProject(env.project(), runDir, "run");
  const out: Record<string, string> = {};
  out[`${kind}.state.json`] = norm(fs.readFileSync(path.join(runDir, "state.json"), "utf8"));
  out[`${kind}.journal.jsonl`] = norm(fs.readFileSync(path.join(runDir, "mail", "journal.jsonl"), "utf8"));
  out[`${kind}.mail.txt`] = norm(
    [...listFiles(path.join(runDir, "mail", "inbox")), ...listFiles(path.join(runDir, "mail", "sent"))]
      .map((f) => `=== ${path.relative(runDir, f)}\n${fs.readFileSync(f, "utf8")}`)
      .join("\n"),
  );
  out[`${kind}.mailtree.txt`] = norm(listFiles(path.join(runDir, "mail")).map((f) => path.relative(runDir, f)).filter((f) => !f.includes("attempts/")).join("\n") + "\n");
  out[`${kind}.status.json`] = norm(JSON.stringify(buildStatusReport(env.project(), "run-1", NOW), null, 2));
  for (const w of wakes) {
    const id = w.agent.replace("#", "-");
    out[`${kind}.wake.${id}.system.txt`] = norm(w.system);
    out[`${kind}.wake.${id}.policy.json`] = norm(w.policy);
    out[`${kind}.wake.${id}.claude.json`] = norm(w.claude);
    out[`${kind}.wake.${id}.codex.json`] = norm(w.codex);
  }
  for (const a of Object.values(bound.agents)) {
    out[`${kind}.static.${a.name}.system.txt`] = norm(buildSystemPrompt(bound, a));
    out[`${kind}.static.${a.name}.policy.json`] = norm(JSON.stringify(writePolicy(bound, a), null, 2));
    out[`${kind}.static.${a.name}.claude.json`] = norm(JSON.stringify(buildClaudeSettings(bound, a), null, 2));
  }
  return { summary, runDir, out, bound };
}

const LEAD_PROMPT = /\.(wake\.lead-\d+|static\.lead)\.system\.txt$/;

/** Compare every captured file with its fixture, except that the lead's system prompt may be checked separately by the caller. */
function checkAll(out: Record<string, string>, opts: { skipLeadPrompt?: boolean; leadSuffix?: boolean } = {}): void {
  for (const [name, text] of Object.entries(out)) {
    if (opts.skipLeadPrompt && LEAD_PROMPT.test(name)) continue;
    // T-C2-1: in worktree mode with the default limit, the lead's wake-up prompt is the HEAD prompt plus the parallel section, nothing else.
    if (opts.leadSuffix && /\.wake\.lead-\d+\.system\.txt$/.test(name)) {
      expect(fs.existsSync(path.join(FIXTURES, name)), `missing fixture ${name}`).toBe(true);
      expect(text, name).toBe(`${fs.readFileSync(path.join(FIXTURES, name), "utf8")}\n\n${PARALLEL_SECTION(4)}`);
      continue;
    }
    fixture(name, text);
  }
}

describe("instances compat: normalize", () => {
  const roots = ["/tmp/x/y"];
  it("replaces only time stamps, pids, durations, random ids, commit ids and the root", () => {
    const text = [
      '{"pid": 4242, "duration_ms": 17, "at": "2026-10-25T07:24:34.377Z"}',
      "20261025T072434377Z-lead-ab12cd34.md /tmp/x/y/home",
      "claim kx3f9a1-fe-member-0a1b2c and 0123456789abcdef0123456789abcdef01234567",
      "ab12cd34 ab12cd34 ee12cd34 deadbeefdeadbeef",
      'id: "123456"',
      "keep: agents/fe-member 12345 v2 abcdefg",
    ].join("\n");
    expect(normalize(text, roots)).toBe(
      [
        '{"pid": 1, "duration_ms": 1, "at": "<ISO>"}',
        "<STAMP>-lead-<ID1>.md <ROOT>/home",
        "claim <CLAIM1> and <SHA1>",
        "<ID1> <ID1> <ID2> <SRC1>",
        "id: <ID3>",
        "keep: agents/fe-member 12345 v2 abcdefg",
      ].join("\n"),
    );
  });
  it("keeps a reused id distinguishable from two different ids", () => {
    expect(normalize("aaaaaaaa aaaaaaaa", [])).not.toBe(normalize("aaaaaaaa bbbbbbbb", []));
  });
});

describe("instances compat: a run where the lead never sets `parallel`", () => {
  it("(a) worktree mode, two plain tasks: state, journal, mail, status --json, prompts, policies are byte-identical", async () => {
    const s = await scenario("a");
    expect(s.summary.outcome).toBe("completed");
    checkAll(s.out, { leadSuffix: true });
    // the fixture really covers a member (both tasks arrive in one wake), the idle third agent, and the whole mail tree
    expect(Object.keys(s.out)).toEqual(expect.arrayContaining(["a.static.qa-member.system.txt", "a.wake.fe-member-1.system.txt", "a.wake.lead-2.system.txt"]));
    expect(s.out["a.mail.txt"]).toContain("subject: first job");
    expect(s.out["a.mail.txt"]).toContain("subject: second job");
    expect(fs.existsSync(path.join(s.runDir, "mail", "inbox", "fe-member", "pending"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(s.runDir, "state.json"), "utf8")).schema_version).toBe(2);
  });

  it("(b) `dispatcher.max_instances: 1` (parallel off) changes nothing, the lead's system prompt included", async () => {
    const s = await scenario("a", "dispatcher:\n  max_instances: 1");
    expect(s.summary.outcome).toBe("completed");
    checkAll(s.out); // no skipLeadPrompt: with the feature off the lead prompt stays byte-identical (spec 23.15 (b))
  });

  it("(d) doctor --resolved: values and sources are unchanged when no new key is written", () => {
    env = makeEnv();
    const { project, sources } = resolveProjectWithSources(env.home, "demo");
    const text = JSON.stringify({ values: flattenResolved(project), sources }, null, 2);
    fixture("d.resolved.json", normalize(text, [env.root, fs.realpathSync(env.root)]));
  });

  it("(e) an old project whose agent is named `fe--x` loads and runs exactly as before", async () => {
    const s = await scenario("e");
    expect(s.summary.outcome).toBe("completed");
    checkAll(s.out, { leadSuffix: true });
  });

  it("(f) a blocked member still gets the lead's next plain task in its own inbox, and there is no pending/ queue", async () => {
    const s = await scenario("f");
    checkAll(s.out, { leadSuffix: true });
    const inbox = path.join(s.runDir, "mail", "inbox", "fe-member");
    expect(fs.existsSync(path.join(inbox, "pending"))).toBe(false);
    const all = listFiles(inbox).map((f) => fs.readFileSync(f, "utf8")).join("\n");
    expect(all).toContain("subject: retry job");
    expect(git(env.repo, "rev-parse", "--is-inside-work-tree")).toBe("true");
  });
});
