import { describe, expect, it } from "vitest";
import { effectiveReadOnly, extraSections, playbookFlag, readOnlyFlag, wakeIsReadOnly } from "../src/playbook.js";

describe("playbookFlag", () => {
  it("accepts a lead task", () => {
    expect(playbookFlag({ value: "investigate", senderIsLead: true, type: "task" })).toBe("investigate");
  });
  it("rejects an unknown name", () => {
    expect(playbookFlag({ value: "bug", senderIsLead: true, type: "task" })).toBe("invalid");
  });
  it("ignores a member and a non-task", () => {
    expect(playbookFlag({ value: "fix", senderIsLead: false, type: "task" })).toEqual({ ignored: "not-lead" });
    expect(playbookFlag({ value: "fix", senderIsLead: true, type: "reply" })).toEqual({ ignored: "not-a-task" });
  });
  it("treats a missing field as absent", () => {
    expect(playbookFlag({ value: undefined, senderIsLead: true, type: "task" })).toBe("absent");
  });
});

describe("readOnlyFlag", () => {
  it("accepts a lead task boolean and treats a string as invalid", () => {
    expect(readOnlyFlag({ value: true, senderIsLead: true, type: "task" })).toBe(true);
    expect(readOnlyFlag({ value: false, senderIsLead: true, type: "task" })).toBe(false);
    expect(readOnlyFlag({ value: "true", senderIsLead: true, type: "task" })).toBe("invalid");
  });
  it("is absent for an empty value, ignored for a member or a non-task", () => {
    expect(readOnlyFlag({ value: undefined, senderIsLead: true, type: "task" })).toBe("absent");
    expect(readOnlyFlag({ value: true, senderIsLead: false, type: "task" })).toEqual({ ignored: "not-lead" });
    expect(readOnlyFlag({ value: true, senderIsLead: true, type: "reply" })).toEqual({ ignored: "not-a-task" });
  });
});

describe("read only", () => {
  it("investigate forces read only", () => {
    expect(effectiveReadOnly("investigate", "absent")).toBe(true);
    expect(effectiveReadOnly("fix", true)).toBe(true);
    expect(effectiveReadOnly("fix", false)).toBe(false);
  });
  it("a wake is read only only when every handled message is a read-only task", () => {
    expect(wakeIsReadOnly([{ type: "task", playbook: "investigate" }])).toBe(true);
    expect(wakeIsReadOnly([{ type: "task", playbook: "investigate" }, { type: "task", playbook: "fix" }])).toBe(false);
    expect(wakeIsReadOnly([])).toBe(false);
  });
});

describe("extraSections", () => {
  it("feature asks for Shape", () => {
    expect(extraSections("feature")).toEqual(["Shape"]);
    expect(extraSections("fix")).toEqual([]);
    expect(extraSections(undefined)).toEqual([]);
  });
});
