export const PLAYBOOKS = ["investigate", "fix", "feature", "refactor"] as const;
export type Playbook = (typeof PLAYBOOKS)[number];

export function isPlaybook(v: unknown): v is Playbook {
  return typeof v === "string" && (PLAYBOOKS as readonly string[]).includes(v);
}

export type PlaybookFlag = "absent" | "invalid" | Playbook | { ignored: "not-lead" | "not-a-task" };

const isEmpty = (v: unknown): boolean => v === undefined || v === null || v === "";

export function playbookFlag(i: { value: unknown; senderIsLead: boolean; type: string }): PlaybookFlag {
  if (isEmpty(i.value)) return "absent";
  if (!i.senderIsLead) return { ignored: "not-lead" };
  if (!isPlaybook(i.value)) return "invalid";
  if (i.type !== "task") return { ignored: "not-a-task" };
  return i.value;
}

export type ReadOnlyFlag = "absent" | "invalid" | boolean | { ignored: "not-lead" | "not-a-task" };

export function readOnlyFlag(i: { value: unknown; senderIsLead: boolean; type: string }): ReadOnlyFlag {
  if (isEmpty(i.value)) return "absent";
  if (!i.senderIsLead) return { ignored: "not-lead" };
  if (typeof i.value !== "boolean") return "invalid";
  if (i.type !== "task") return { ignored: "not-a-task" };
  return i.value;
}

/** investigate 為真；明確的 true 為真；false、absent、ignored 為假。 */
export function effectiveReadOnly(playbook: Playbook | undefined, flag: ReadOnlyFlag): boolean {
  return playbook === "investigate" || flag === true;
}

/** feature 要多一個 Shape；其他 playbook 沒有額外標題。 */
export function extraSections(playbook: Playbook | undefined): string[] {
  return playbook === "feature" ? ["Shape"] : [];
}

export function wakeIsReadOnly(messages: readonly { type: string; playbook?: string; read_only?: unknown }[]): boolean {
  return (
    messages.length > 0 &&
    messages.every(
      (m) =>
        m.type === "task" &&
        effectiveReadOnly(isPlaybook(m.playbook) ? m.playbook : undefined, m.read_only === true ? true : m.read_only === false ? false : "absent"),
    )
  );
}
