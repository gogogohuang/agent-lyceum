import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildGoldenEnv, goldenCases, statusOutput } from "./status-golden-fixture.js";

// Frozen baselines, generated once from the 0.17.3 code. This test only reads them: there is no update mode, and a missing baseline fails.
// Never overwrite a baseline with the output of newer code; `status --json` is read by plugins/status-monitor.
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "status-golden");

describe("status --json golden output", () => {
  for (const c of goldenCases()) {
    it(`${c.file} is byte-for-byte unchanged`, () => {
      const env = buildGoldenEnv(c.count);
      try {
        const out = statusOutput(env, c.args);
        expect(out).not.toContain(fs.realpathSync(os.tmpdir()));
        expect(out).not.toContain(os.tmpdir());
        const file = path.join(dir, c.file);
        expect(fs.existsSync(file), `missing baseline ${file}`).toBe(true);
        expect(out).toBe(fs.readFileSync(file, "utf8"));
      } finally {
        env.cleanup();
      }
    }, 30000);
  }
});
