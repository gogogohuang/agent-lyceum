import fs from "node:fs";
import path from "node:path";
import type { ResolvedAgent, ResolvedProject } from "./config.js";
import { commonFile, mayEditProtected, repoInstructionFiles } from "./policy.js";

export interface Violation {
  file: string;
  action: "restored" | "removed";
  suspects: string[];
}

/**
 * Detects (and reverts) changes to protected files made by agents that may not edit them.
 * This is the runtime-independent safety net behind the OS/tool-level enforcement.
 */
export class ProtectedGuard {
  private baseline = new Map<string, Buffer | null>();

  constructor(private project: ResolvedProject) {
    for (const f of ProtectedGuard.protectedFiles(project)) this.baseline.set(f, read(f));
  }

  static protectedFiles(project: ResolvedProject): string[] {
    const files = new Set<string>();
    for (const a of Object.values(project.agents)) files.add(a.agentMd);
    files.add(commonFile(project));
    for (const f of repoInstructionFiles(project)) files.add(f);
    return [...files];
  }

  /** Copy the current protected files into `dir` for the audit trail. */
  saveSnapshot(dir: string): void {
    fs.mkdirSync(dir, { recursive: true });
    for (const [file, buf] of this.baseline) {
      if (!buf) continue;
      const safe = file.replace(/[\\/:]/g, "_").replace(/^_+/, "");
      fs.writeFileSync(path.join(dir, safe), buf);
    }
  }

  /** Compare against the baseline after `running` agents finished; revert unauthorized changes. */
  check(running: ResolvedAgent[]): Violation[] {
    const violations: Violation[] = [];
    for (const [file, before] of this.baseline) {
      const now = read(file);
      if (same(before, now)) continue;
      const authorized = running.some((a) => mayEditProtected(this.project, a, file));
      if (authorized) {
        this.baseline.set(file, now);
        continue;
      }
      if (before === null) {
        fs.rmSync(file, { force: true });
        violations.push({ file, action: "removed", suspects: running.map((a) => a.name) });
      } else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, before);
        violations.push({ file, action: "restored", suspects: running.map((a) => a.name) });
      }
    }
    return violations;
  }
}

function read(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function same(a: Buffer | null, b: Buffer | null): boolean {
  if (a === null || b === null) return a === b;
  return a.equals(b);
}
