import { spawnSync } from "node:child_process";
import { applyDefaults, askReplyPath, checkAnswers, describeCheck, isComplete, readAskReply, writeAskReply } from "./ask-reply.js";

export interface PrepareResult {
  complete: boolean;
  problems: string[];
  path: string;
}

/** Read the ask-reply file of a waiting run. With `assumeDefaults`, unanswered questions that have a suggestion take it (and the file is saved). */
export function prepareAnswers(runDir: string, opts: { assumeDefaults?: boolean }): PrepareResult {
  const file = askReplyPath(runDir);
  let reply = readAskReply(runDir);
  if (!reply) return { complete: false, problems: ["ask-reply.md does not exist"], path: file };
  if (opts.assumeDefaults) {
    reply = applyDefaults(reply);
    writeAskReply(runDir, reply);
  }
  const check = checkAnswers(reply);
  return { complete: isComplete(check), problems: describeCheck(check), path: file };
}

export function openInEditor(file: string, env: NodeJS.ProcessEnv = process.env): void {
  const editor = env.VISUAL || env.EDITOR || "vi";
  const r = spawnSync(`${editor} ${JSON.stringify(file)}`, { shell: true, stdio: "inherit", env });
  if (r.error || (r.status ?? 0) !== 0) throw new Error(`The editor "${editor}" failed${r.error ? `: ${r.error.message}` : ` (exit ${r.status})`}.`);
}
