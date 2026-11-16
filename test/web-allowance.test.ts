import { describe, expect, it } from "vitest";
import { allowanceTone, orderReports, runtimeName, wholePercent } from "../web/src/client/allowance-view";

describe("allowance view helpers", () => {
  it("tones by remaining percent", () => {
    expect(allowanceTone(100)).toBe("ok");
    expect(allowanceTone(50)).toBe("ok");
    expect(allowanceTone(49.9)).toBe("mid");
    expect(allowanceTone(20)).toBe("mid");
    expect(allowanceTone(19.9)).toBe("low");
    expect(allowanceTone(0)).toBe("low");
  });

  it("rounds and clamps the displayed percent", () => {
    expect(wholePercent(42.6)).toBe(43);
    expect(wholePercent(-3)).toBe(0);
    expect(wholePercent(120)).toBe(100);
  });

  it("puts Claude before Codex", () => {
    const ordered = orderReports([
      { runtime: "codex", windows: [] },
      { runtime: "claude", windows: [] },
    ]);
    expect(ordered.map((r) => runtimeName(r.runtime))).toEqual(["Claude", "Codex"]);
  });
});
