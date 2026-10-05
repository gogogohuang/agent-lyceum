import fs from "node:fs";
import path from "node:path";
import { absPath } from "./paths.js";

export const TASK_FILE_MAX = 1024 * 1024;
export const TASK_INLINE_MAX = 16 * 1024;

export interface PreparedTask {
  source: "text" | "file";
  /** Original file path when source is "file". */
  sourcePath?: string;
  /** Read-only copy kept in the run dir. */
  copyPath: string;
  content: string;
  inline: boolean;
  bytes: number;
}

export function readTaskFile(file: string): string {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error(`Task file not found: ${file}`);
  }
  if (!st.isFile()) throw new Error(`Task file is not a regular file: ${file}`);
  if (st.size === 0) throw new Error(`Task file is empty: ${file}`);
  if (st.size > TASK_FILE_MAX) {
    throw new Error(`Task file is ${st.size} bytes; the limit is ${TASK_FILE_MAX} (1 MB). Shorten it or split the work.`);
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`Task file is not readable: ${file} (${(e as Error).message})`);
  }
  if (!text.trim()) throw new Error(`Task file is empty: ${file}`);
  return text;
}

/** Resolve CLI input into a task; never modifies the source file. */
export function prepareTask(opts: { text?: string; file?: string; cwd: string; runDir: string }): PreparedTask {
  const hasText = opts.text !== undefined && opts.text.trim() !== "";
  if (hasText && opts.file) throw new Error('Give either a task text or --task-file, not both.');
  if (!hasText && !opts.file) throw new Error('No task given. Use `run "<task>"` or `run --task-file <path>`.');

  let content: string;
  let sourcePath: string | undefined;
  if (opts.file) {
    sourcePath = absPath(opts.file, opts.cwd);
    content = readTaskFile(sourcePath);
  } else {
    content = opts.text!.trim();
  }
  const bytes = Buffer.byteLength(content);
  const copyPath = path.join(opts.runDir, "task.md");
  fs.mkdirSync(opts.runDir, { recursive: true });
  fs.writeFileSync(copyPath, content.endsWith("\n") ? content : content + "\n", { mode: 0o444 });
  return {
    source: opts.file ? "file" : "text",
    sourcePath,
    copyPath,
    content,
    inline: bytes <= TASK_INLINE_MAX,
    bytes,
  };
}

export function taskMessageBody(task: PreparedTask): { subject: string; body: string } {
  const first = task.content.split("\n").find((l) => l.trim()) ?? "Task";
  const subject = first.replace(/^#+\s*/, "").slice(0, 80);
  if (task.inline) return { subject, body: task.content };
  return {
    subject,
    body:
      `The task is large (${task.bytes} bytes), so it is not inlined here. Read it from \`${task.copyPath}\` before doing anything else.\n\n` +
      `First lines:\n\n${task.content.split("\n").slice(0, 10).join("\n")}\n`,
  };
}
