import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRunState } from "../src/run-store.js";
import { newWorld, OK, run, send, type Script, type World } from "./instances-harness.js";

// Real git and several wake-ups: the default 5 s is too short when the whole suite runs at once.
vi.setConfig({ testTimeout: 30_000 });

let world: World;
afterEach(() => world?.env.cleanup());

describe("T-11: tier on parallel tasks", () => {
  it("two parallel lead tasks with tier low wake both instances on the low model, each with its own session key", async () => {
    world = newWorld((p) => {
      const a = p.agents["fe-member"]!;
      a.model = "opus";
      a.resume = true;
      a.tiers = ["haiku", "sonnet", "opus"];
    });
    const models: Record<string, (string | undefined)[]> = {};
    const script: Script = async (w) => {
      if (w.agent === "lead") {
        if (w.n === 1) {
          send(w.i, "fe-member", "task one", "task", "parallel: true\ntier: low\n");
          send(w.i, "fe-member", "task two", "task", "parallel: true\ntier: low\n");
        } else if ((models["fe-member"]?.length ?? 0) >= 1 && (models["fe-member--2"]?.length ?? 0) >= 1) send(w.i, "lead", "bye", "done");
        return;
      }
      const list = models[w.agent] ?? [];
      list.push(w.i.agent.model);
      models[w.agent] = list;
      send(w.i, "lead", `finished by ${w.agent}`, "reply");
      return { ...OK, sessionId: `S-${w.agent}` };
    };
    const s = await run(world, script);
    expect(s.endReason).toBe("done");
    expect(models["fe-member"]).toEqual(["haiku"]);
    expect(models["fe-member--2"]).toEqual(["haiku"]);
    const sessions = Object.keys(loadRunState(world.runDir).sessions);
    expect(sessions).toEqual(expect.arrayContaining(["fe-member@claude-code/haiku", "fe-member--2@claude-code/haiku"]));
  });
});
