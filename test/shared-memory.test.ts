import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeInvocation, buildClaudeSettings } from "../src/adapters/claude.js";
import { codexWritableRoots } from "../src/adapters/codex.js";
import { ProtectedGuard } from "../src/guard.js";
import type { Invoker, WakeInput, WakeResult } from "../src/adapters/index.js";
import { runTeam } from "../src/dispatcher.js";
import { commonFile, enforcementFor, recordsDir, outboxDir, sharedDir, sharedIndex, writePolicy } from "../src/policy.js";
import { HANDOFF_LIMIT, buildSystemPrompt, buildUserPrompt } from "../src/prompt.js";
import { soloProject } from "../src/solo.js";
import { prepareTask } from "../src/task.js";
import { bindRunProject, loadRunState } from "../src/run-store.js";
import { FULL_DONE, REPLY_BODY, TASK_BODY, makeEnv, write, type ClaudeSettingsView, type TestEnv } from "./helpers.js";

let env: TestEnv;
afterEach(() => env?.cleanup());

const bound = () => bindRunProject(env.project(), path.join(env.root, "run-1"), "run");

describe("the handoff folder: where it is and who may write it", () => {
  it("sits in the run's task memory under a name no agent can have, and only for a run", () => {
    env = makeEnv();
    const p = bound();
    expect(sharedDir(p)).toBe(path.join(p.paths.taskMemory, "run-1", "_shared"));
    expect(sharedIndex(p)).toBe(path.join(sharedDir(p) as string, "MEMORY.md"));
    expect(sharedDir(env.project())).toBeUndefined(); // not bound to a run
    expect(sharedDir({ ...p, solo: "call" })).toBeUndefined();
  });

  it("only the lead may write it; everyone else may read it but is denied", () => {
    env = makeEnv();
    const p = bound();
    const dir = sharedDir(p) as string;
    const lead = writePolicy(p, p.agents.lead);
    expect(lead.allowDirs).toContain(dir);
    expect(lead.allowFiles).toContain(sharedIndex(p));
    expect(lead.deny).not.toContain(dir);
    expect(lead.readDirs).not.toContain(dir);
    const member = writePolicy(p, p.agents["fe-member"]);
    expect(member.allowDirs).not.toContain(dir);
    expect(member.allowFiles).not.toContain(sharedIndex(p));
    expect(member.deny).toContain(dir);
    expect(member.readDirs).toEqual([dir]);
  });

  it("policies outside a run are exactly what they were", () => {
    env = makeEnv();
    const p = env.project();
    expect(writePolicy(p, p.agents["fe-member"]).readDirs).toEqual([]);
    expect(writePolicy(p, p.agents.lead).allowDirs.some((d) => d.endsWith("_shared"))).toBe(false);
  });

  it("Claude: a member can read the folder (--add-dir) but the sandbox does not let it write there; the lead can write", () => {
    env = makeEnv();
    const p = bound();
    const dir = sharedDir(p) as string;
    const member = buildClaudeSettings(p, p.agents["fe-member"]) as unknown as ClaudeSettingsView;
    expect(member.sandbox.filesystem.allowWrite).not.toContain(dir);
    expect(member.sandbox.filesystem.denyWrite).toContain(dir);
    const lead = buildClaudeSettings(p, p.agents.lead) as unknown as ClaudeSettingsView;
    expect(lead.sandbox.filesystem.allowWrite).toContain(dir);

    const dirsOf = (agent: string) => {
      const inv = buildClaudeInvocation({ project: p, agent: p.agents[agent], workDir: path.join(env.root, `work-${agent}`), systemPrompt: "s", userPrompt: "u", timeoutSec: 60 });
      return inv.args.flatMap((x, i) => (x === "--add-dir" ? [inv.args[i + 1]] : []));
    };
    expect(dirsOf("fe-member")).toContain(dir);
    expect(dirsOf("lead")).toContain(dir);
  });

  it("Codex: the folder is a writable root for the lead only", () => {
    env = makeEnv();
    const p = bound();
    const dir = sharedDir(p) as string;
    const roots = (agent: string) => codexWritableRoots({ project: p, agent: p.agents[agent], workDir: env.root, systemPrompt: "s", userPrompt: "u", timeoutSec: 60 });
    expect(roots("lead")).toContain(dir);
    expect(roots("fe-member")).not.toContain(dir);
  });

  it("the guard puts back a member's edit of the handoff index and lets the lead write it", () => {
    env = makeEnv();
    const p = bound();
    const idx = sharedIndex(p) as string;
    const g = new ProtectedGuard(p);
    write(idx, "a member was here\n");
    expect(g.check([p.agents["fe-member"]])).toMatchObject([{ file: idx, action: "removed", suspects: ["fe-member"] }]);
    expect(fs.existsSync(idx)).toBe(false);
    g.rebase();
    write(idx, "- decisions: see decisions.md\n");
    expect(g.check([p.agents.lead])).toEqual([]);
    expect(fs.readFileSync(idx, "utf8")).toContain("decisions");
  });

  it("keeps a member's records edits", () => {
    env = makeEnv();
    const p = bound();
    const dec = path.join(recordsDir(p), "decisions", "keep.md");
    const arc = path.join(recordsDir(p), ".archive", "old.md");
    write(dec, "original\n");
    write(arc, "archived\n");
    const g = new ProtectedGuard(p);
    const member = p.agents["fe-member"];
    const added = path.join(recordsDir(p), "decisions", "new.md");
    write(dec, "tampered\n");
    fs.rmSync(arc);
    write(added, "x\n");
    const v = g.check([member]);
    expect(v).toEqual([]);
    expect(fs.readFileSync(dec, "utf8")).toBe("tampered\n");
    expect(fs.existsSync(arc)).toBe(false);
    expect(fs.readFileSync(added, "utf8")).toBe("x\n");
  });

  it("keeps a member's records root or kind folder swapped for a symlink and does not write through it", () => {
    for (const mode of ["root", "nested"]) {
      env = makeEnv();
      const p = bound();
      const root = recordsDir(p);
      const dec = path.join(root, "decisions", "keep.md");
      write(dec, "original\n");
      const outside = path.join(env.root, `outside-${mode}`);
      const sentinel = path.join(outside, "keep.md");
      write(sentinel, "sentinel\n");
      write(path.join(outside, "decisions", "keep.md"), "sentinel-nested\n");
      const g = new ProtectedGuard(p);
      if (mode === "root") {
        fs.rmSync(root, { recursive: true });
        fs.symlinkSync(outside, root);
      } else {
        fs.rmSync(path.dirname(dec), { recursive: true });
        fs.symlinkSync(outside, path.dirname(dec));
      }
      const v = g.check([p.agents["fe-member"]!]);
      const link = mode === "root" ? root : path.dirname(dec);
      expect(v).toEqual([]);
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(sentinel, "utf8")).toBe("sentinel\n");
      expect(fs.readFileSync(path.join(outside, "decisions", "keep.md"), "utf8")).toBe("sentinel-nested\n");
      env.cleanup();
    }
  });

  it("skips records protection when shared/common is a symlink", () => {
    env = makeEnv();
    const p = bound();
    const root = recordsDir(p);
    write(path.join(root, "decisions", "keep.md"), "original\n");
    const g = new ProtectedGuard(p);
    const common = path.dirname(root);
    const moved = path.join(env.root, "moved-common");
    fs.renameSync(common, moved);
    fs.mkdirSync(path.join(env.root, "evil", "records"), { recursive: true });
    fs.symlinkSync(path.join(env.root, "evil"), common);
    g.check([p.agents["fe-member"]]);
    expect(fs.readdirSync(path.join(env.root, "evil", "records"))).toEqual([]);
  });

  it("reports a shared level: n/a for the lead, a real level for members", () => {
    env = makeEnv();
    const p = bound();
    expect(enforcementFor(p, p.agents.lead).shared).toBe("n/a");
    const m = enforcementFor(p, p.agents["fe-member"]);
    expect(["os", "tool-rules", "post-hoc"]).toContain(m.shared);
  });
});

describe("prompts", () => {
  it("tells agents that mail missing a heading is sent back at most twice", () => {
    env = makeEnv();
    const p = bound();
    expect(buildSystemPrompt(p, p.agents["fe-member"])).toContain("is sent back to you (at most twice per sender + type + subject)");
  });
  it("the lead is told to write handoff notes before done; a member is not", () => {
    env = makeEnv();
    const p = bound();
    const lead = buildSystemPrompt(p, p.agents.lead);
    expect(lead).toContain("Handoff for follow-ups");
    expect(lead).toContain(sharedDir(p) as string);
    expect(buildSystemPrompt(p, p.agents["fe-member"])).not.toContain("Handoff for follow-ups");
  });

  it("a solo run agent is told too; a call is not", () => {
    env = makeEnv();
    const sp = bindRunProject(soloProject(env.project(), "fe-member"), path.join(env.root, "run-1"), "run");
    expect(buildSystemPrompt(sp, sp.agents["fe-member"])).toContain("Handoff for follow-ups");
    expect(buildSystemPrompt({ ...sp, solo: "call" }, sp.agents["fe-member"])).not.toContain("Handoff for follow-ups");
  });

  it("the user prompt carries the index only when asked to, only when it has text, and caps it", () => {
    env = makeEnv();
    const p = bound();
    const idx = sharedIndex(p) as string;
    write(idx, "- decided: sessions, not JWT\n");
    expect(buildUserPrompt(p, p.agents.lead, [], 1)).not.toContain("Handoff notes");
    const withNotes = buildUserPrompt(p, p.agents["fe-member"], [], 1, true);
    expect(withNotes).toContain(`# Handoff notes from earlier segments of this task (${idx})`);
    expect(withNotes).toContain("decided: sessions, not JWT");

    write(idx, "   \n");
    expect(buildUserPrompt(p, p.agents.lead, [], 1, true)).not.toContain("Handoff notes");

    write(idx, "x".repeat(HANDOFF_LIMIT + 100));
    expect(buildUserPrompt(p, p.agents.lead, [], 1, true)).toContain(`truncated at ${HANDOFF_LIMIT} bytes`);
  });
});

const OK: WakeResult = { ok: true, text: "", exitCode: 0, timedOut: false };
const send = (i: WakeInput, to: string, type: string, subject: string) =>
  write(
    path.join(outboxDir(i.project, i.agent.name), `${Date.now()}-${Math.random()}.md`),
    `---\nto: ${to}\ntype: ${type}\nsubject: ${subject}\n${type === "done" ? "outcome: completed\n" : ""}---\n\n${type === "done" ? FULL_DONE.replace("Shipped.", subject) : (type === "task" ? TASK_BODY : REPLY_BODY).replace("None", subject)}\n`,
  );
const firstSegment = async (invoker: Invoker) => {
  const project = env.project();
  const runDir = path.join(project.paths.runs, "run-1");
  const task = prepareTask({ text: "Build login", cwd: env.root, runDir });
  const summary = await runTeam({ project, task, runDir, log: () => {}, invoker });
  return { project, runDir, summary };
};
/** The lead writes handoff notes, then reports done. */
const leadWritesNotes: Invoker = async (i) => {
  write(path.join(sharedDir(i.project) as string, "MEMORY.md"), "- decided: sessions, not JWT\n");
  send(i, i.agent.name, "done", "first result");
  return OK;
};

describe("a reopened run starts from the handoff notes", () => {
  it("the lead and a member both see them after the reopen, and the first segment's prompts do not", async () => {
    env = makeEnv();
    const first: string[] = [];
    const { project, runDir } = await firstSegment(async (i) => {
      first.push(i.userPrompt);
      return leadWritesNotes(i);
    });
    expect(first.join("\n")).not.toContain("Handoff notes");
    expect((loadRunState(runDir).notes ?? []).some((n) => n.includes("shared-not-updated"))).toBe(false);

    const prompts: Record<string, string[]> = {};
    await runTeam({
      project,
      resume: loadRunState(runDir),
      runDir,
      log: () => {},
      followup: { text: "Also add rate limiting" },
      invoker: async (i) => {
        const seen = prompts[i.agent.name] ?? [];
        prompts[i.agent.name] = seen;
        seen.push(i.userPrompt);
        if (i.agent.name !== "lead") send(i, "lead", "reply", "limiter done");
        else if (seen.length === 1) send(i, "fe-member", "task", "do the limiter");
        else send(i, i.agent.name, "done", "second result");
        return OK;
      },
    });
    const idx = path.join(project.paths.taskMemory, "run-1", "_shared", "MEMORY.md");
    for (const who of ["lead", "fe-member"]) {
      const text = (prompts[who] as string[]).join("\n");
      expect(text).toContain("decided: sessions, not JWT");
      expect(text).toContain("# Handoff notes from earlier segments of this task");
    }
    expect((prompts.lead as string[])[0]).toContain(`handoff notes written for follow-ups are in \`${idx}\``);
  });

  it("a lead that does not update the notes before done is noted, not blocked; the run can still be reopened", async () => {
    env = makeEnv();
    const { project, runDir, summary } = await firstSegment(async (i) => {
      send(i, i.agent.name, "done", "first result");
      return OK;
    });
    expect(summary.endReason).toBe("done");
    const noted = (loadRunState(runDir).notes ?? []).filter((n) => n.includes("shared-not-updated"));
    expect(noted).toHaveLength(1);
    expect(noted[0]).toContain("did not write handoff notes");
    expect(noted[0]).toContain("will start without handoff notes");

    let seen = "";
    const second = await runTeam({
      project,
      resume: loadRunState(runDir),
      runDir,
      log: () => {},
      followup: { text: "More please" },
      invoker: async (i) => {
        seen = i.userPrompt;
        send(i, i.agent.name, "done", "second result");
        return OK;
      },
    });
    expect(second.endReason).toBe("done");
    expect(seen).not.toContain("Handoff notes");
    expect(seen).not.toContain("handoff notes written for follow-ups");
  });

  it("a run from before the folder existed reopens fine, and the folder is created", async () => {
    env = makeEnv();
    const { project, runDir } = await firstSegment(leadWritesNotes);
    fs.rmSync(path.join(project.paths.taskMemory, "run-1", "_shared"), { recursive: true, force: true });
    const second = await runTeam({
      project,
      resume: loadRunState(runDir),
      runDir,
      log: () => {},
      followup: { text: "More please" },
      invoker: async (i) => {
        send(i, i.agent.name, "done", "second result");
        return OK;
      },
    });
    expect(second.endReason).toBe("done");
    expect(fs.existsSync(path.join(project.paths.taskMemory, "run-1", "_shared"))).toBe(true);
  });
});

describe("the shared-not-updated note", () => {
  const notesOf = (runDir: string) => (loadRunState(runDir).notes ?? []).filter((n) => n.includes("shared-not-updated"));

  it("is not made by a plain resume of an interrupted run (no baseline for that segment)", async () => {
    env = makeEnv();
    const ctl = new AbortController();
    const project = env.project();
    const runDir = path.join(project.paths.runs, "run-1");
    const task = prepareTask({ text: "Build login", cwd: env.root, runDir });
    const first = await runTeam({
      project,
      task,
      runDir,
      log: () => {},
      signal: ctl.signal,
      invoker: async (i) => {
        write(path.join(sharedDir(i.project) as string, "MEMORY.md"), "- decided: sessions\n");
        send(i, "fe-member", "task", "do it");
        ctl.abort();
        return OK;
      },
    });
    expect(first.endReason).toBe("cancelled");
    const second = await runTeam({
      project,
      resume: loadRunState(runDir),
      runDir,
      log: () => {},
      invoker: async (i) => {
        if (i.agent.name === "lead") send(i, i.agent.name, "done", "result");
        else send(i, "lead", "reply", "member done");
        return OK;
      },
    });
    expect(second.endReason).toBe("done");
    expect(notesOf(runDir)).toEqual([]);
  });

  it("says a follow-up will see untouched notes as they are", async () => {
    env = makeEnv();
    const { project, runDir } = await firstSegment(leadWritesNotes);
    await runTeam({
      project,
      resume: loadRunState(runDir),
      runDir,
      log: () => {},
      followup: { text: "More please" },
      invoker: async (i) => {
        send(i, i.agent.name, "done", "second result");
        return OK;
      },
    });
    const noted = notesOf(runDir);
    expect(noted).toHaveLength(1);
    expect(noted[0]).toContain("did not change the handoff notes");
    expect(noted[0]).toContain("will see them as they are");
  });
});

describe("the capped reads never hang or throw", () => {
  it("a directory, a FIFO or a missing file at the index or COMMON.md is treated as empty", () => {
    env = makeEnv();
    const p = bound();
    const idx = sharedIndex(p) as string;
    fs.rmSync(idx, { force: true });
    fs.mkdirSync(idx, { recursive: true });
    expect(buildUserPrompt(p, p.agents.lead, [], 1, true)).not.toContain("Handoff notes");

    fs.rmSync(idx, { recursive: true });
    if (process.platform !== "win32") {
      execFileSync("mkfifo", [idx]);
      expect(buildUserPrompt(p, p.agents.lead, [], 1, true)).not.toContain("Handoff notes");
      fs.rmSync(idx);
    }

    const common = path.join(env.root, "COMMON.dir");
    fs.mkdirSync(common);
    fs.mkdirSync(path.dirname(commonFile(p)), { recursive: true });
    fs.rmSync(commonFile(p), { force: true });
    fs.symlinkSync(common, commonFile(p));
    expect(buildUserPrompt(p, p.agents.lead, [], 1)).toContain("# Shared team context (COMMON.md)");
  });

  it("a file through a symlink still reads, and a big one is cut at the limit", () => {
    env = makeEnv();
    const p = bound();
    const idx = sharedIndex(p) as string;
    const real = path.join(env.root, "real.md");
    write(real, "y".repeat(HANDOFF_LIMIT * 3));
    fs.mkdirSync(path.dirname(idx), { recursive: true });
    fs.rmSync(idx, { force: true });
    fs.symlinkSync(real, idx);
    const out = buildUserPrompt(p, p.agents.lead, [], 1, true);
    expect(out).toContain(`truncated at ${HANDOFF_LIMIT} bytes`);
    expect(out.length).toBeLessThan(HANDOFF_LIMIT * 2);
  });
});

describe("enforcement notes", () => {
  it("a non-lead Claude agent without the OS sandbox is told Bash can write _shared", () => {
    env = makeEnv();
    const p = bound();
    const m = enforcementFor(p, p.agents["fe-member"]);
    // The sandbox probe depends on the platform; the note must be there exactly when the level is not OS-enforced.
    expect(m.notes.some((n) => n.includes("Bash can write _shared"))).toBe(m.shared !== "os");
    expect(enforcementFor(p, p.agents.lead).notes.some((n) => n.includes("Bash can write _shared"))).toBe(false);
  });
});
