import { describe, expect, it } from "vitest";
import { boundCommands, unboundCommands } from "../src/task-bind.js";

const task = `# T
## Verification
See \`npm test\` for context.
- \`npm test\`
- not a command

\`\`\`
npm run typecheck
\`\`\`
`;

describe("boundCommands", () => {
  it("takes a bullet that is only a command, and a fenced line, not prose", () => {
    expect(boundCommands(task)).toEqual(["npm test", "npm run typecheck"]);
  });
  it("reports commands that project.yaml does not list", () => {
    expect(unboundCommands(task, ["npm test"])).toEqual(["npm run typecheck"]);
  });
  it("returns nothing when the section is absent", () => {
    expect(boundCommands("# T\n## Goal\n- `npm test`")).toEqual([]);
  });
  it("reads a fenced block that names a language", () => {
    expect(boundCommands("## Verification\n```bash\nnpm test\n```")).toEqual(["npm test"]);
  });
});
