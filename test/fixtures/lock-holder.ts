// Helper process for project-lock tests: tries to take the lock, reports, optionally holds it.
import { acquireProjectLock } from "../../src/project-lock.js";

const [root, runId, holdMs] = process.argv.slice(2);
try {
  const lease = acquireProjectLock(root, runId);
  process.stdout.write("ACQUIRED\n");
  setTimeout(() => {
    lease.release();
    process.exit(0);
  }, Number(holdMs ?? 0));
} catch (e) {
  process.stdout.write(`DENIED ${(e as Error).message}\n`);
  process.exit(3);
}
