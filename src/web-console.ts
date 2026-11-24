import fs from "node:fs";
import path from "node:path";
import { prepareAnswers } from "./ask-answer.js";
import { readAskReply, writeAskReply } from "./ask-reply.js";
import { listProjects } from "./config.js";
import { parseRaw } from "./mailbox.js";
import { NAME_RE, projectPaths } from "./paths.js";

export type ReportItem = { id: string; kind: "result" | "done" | "agent"; title: string; agent?: string; outcome?: string; created?: string };

const REPORT_ID_RE = /^(result|done-\d{1,4}|mail-[0-9a-f]{8})$/;
const AGENT_MAIL_TYPES = new Set(["reply", "done", "failure"]);

function headingOf(text: string): string | undefined {
  return /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
}

function outcomeOf(text: string): string | undefined {
  return /^\*\*Outcome:\*\*\s*(\S+)/m.exec(text)?.[1];
}

/** Every mail an agent sent (reply, done, failure) under the run's inbox folders, read or not. */
function agentMails(runDir: string): { id: string; file: string; from: string; subject: string; created?: string }[] {
  const inbox = path.join(runDir, "mail", "inbox");
  const out: { id: string; file: string; from: string; subject: string; created?: string }[] = [];
  const dirs = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []);
  for (const agent of dirs(inbox)) {
    if (!agent.isDirectory()) continue;
    for (const folder of [path.join(inbox, agent.name), path.join(inbox, agent.name, "read")]) {
      for (const entry of dirs(folder)) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const file = path.join(folder, entry.name);
        try {
          const { data } = parseRaw(fs.readFileSync(file, "utf8"));
          const id = String(data.id ?? "");
          if (!/^[0-9a-f]{8}$/.test(id) || !AGENT_MAIL_TYPES.has(String(data.type))) continue;
          out.push({ id, file, from: String(data.from ?? ""), subject: String(data.subject ?? ""), ...(data.created ? { created: String(data.created) } : {}) });
        } catch {
          // A mail that does not parse is not a report.
        }
      }
    }
  }
  return out;
}

/** What the web page's command console needs from this side of the package (`web/` cannot import `src/`). Same shape as `ConsoleDeps` in `web/src/server/api.ts`. */
export function createConsoleDeps(home: string, cliFile: string) {
  const projectDir = (name: string): string | undefined => listProjects(home).find((p) => p.name === name)?.dir;

  const runDirOf = (project: string, runId: string): string | undefined => {
    if (!NAME_RE.test(project) || !NAME_RE.test(runId) || !projectDir(project)) return undefined;
    const dir = path.join(projectPaths(home, project).runs, runId);
    return fs.existsSync(dir) ? dir : undefined;
  };

  return {
    home,
    cli: { execPath: process.execPath, args: [...process.execArgv, cliFile] as readonly string[] },
    projectDir,
    readAsk(project: string, runId: string) {
      const dir = runDirOf(project, runId);
      const reply = dir ? readAskReply(dir) : undefined;
      if (!reply) return undefined;
      return {
        status: reply.status,
        questions: reply.questions.map((q) => ({
          id: q.id,
          text: q.text,
          asker: q.asker,
          ...(q.options ? { options: q.options } : {}),
          ...(q.suggested ? { suggested: q.suggested } : {}),
          ...(q.answer ? { answer: q.answer.value } : {}),
          delivered: q.delivered === true,
        })),
      };
    },
    listReports(project: string, runId: string): ReportItem[] | undefined {
      const dir = runDirOf(project, runId);
      if (!dir) return undefined;
      const items: ReportItem[] = [];
      const files = fs.readdirSync(dir).filter((f) => f === "result.md" || /^done-\d{1,4}\.md$/.test(f));
      for (const f of files) {
        const text = fs.readFileSync(path.join(dir, f), "utf8");
        const id = f.slice(0, -3);
        const outcome = outcomeOf(text);
        items.push({ id, kind: id === "result" ? "result" : "done", title: headingOf(text) ?? f, ...(outcome ? { outcome } : {}), created: fs.statSync(path.join(dir, f)).mtime.toISOString() });
      }
      // Newest final report first: result.md, then done-N from the highest N.
      items.sort((a, b) => (a.id === "result" ? -1 : b.id === "result" ? 1 : Number(b.id.slice(5)) - Number(a.id.slice(5))));
      const mails = agentMails(dir).sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
      for (const m of mails) items.push({ id: `mail-${m.id}`, kind: "agent", title: m.subject || m.id, agent: m.from, ...(m.created ? { created: m.created } : {}) });
      return items;
    },
    readReport(project: string, runId: string, id: string): { id: string; title: string; markdown: string } | undefined {
      const dir = runDirOf(project, runId);
      if (!dir || !REPORT_ID_RE.test(id)) return undefined;
      if (id.startsWith("mail-")) {
        const mail = agentMails(dir).find((m) => `mail-${m.id}` === id);
        if (!mail) return undefined;
        return { id, title: mail.subject || mail.id, markdown: parseRaw(fs.readFileSync(mail.file, "utf8")).body };
      }
      const file = path.join(dir, `${id}.md`);
      if (!fs.existsSync(file)) return undefined;
      const markdown = fs.readFileSync(file, "utf8");
      return { id, title: headingOf(markdown) ?? id, markdown };
    },
    saveAnswers(project: string, runId: string, answers: Record<string, string>, assumeDefaults: boolean): { complete: boolean; problems: string[] } {
      const dir = runDirOf(project, runId);
      const reply = dir ? readAskReply(dir) : undefined;
      if (!dir || !reply) return { complete: false, problems: ["這次任務沒有待回答的問題。"] };
      writeAskReply(dir, {
        ...reply,
        questions: reply.questions.map((q) => {
          const value = answers[q.id]?.trim();
          return q.delivered || !value ? q : { ...q, answer: { value, by: "user" as const } };
        }),
      });
      const checked = prepareAnswers(dir, { assumeDefaults });
      return { complete: checked.complete, problems: checked.problems };
    },
  };
}
