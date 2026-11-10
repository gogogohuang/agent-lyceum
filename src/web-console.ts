import fs from "node:fs";
import path from "node:path";
import { prepareAnswers } from "./ask-answer.js";
import { readAskReply, writeAskReply } from "./ask-reply.js";
import { listProjects } from "./config.js";
import { NAME_RE, projectPaths } from "./paths.js";

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
