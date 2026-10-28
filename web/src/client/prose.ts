const DONE: Record<string, string> = {
  completed: "完成",
  partial: "部分完成",
  blocked: "受阻",
  failed: "失敗",
  cancelled: "已取消",
  waiting: "等待回答",
};

/** The sentence a person can read. A JSON `message` wins; otherwise the first paragraph. */
export function readableError(error: string): string {
  const found: string[] = [];
  const re = /"message"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(error))) {
    const message = match[1];
    if (message !== undefined) found.push(message.replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
  }
  const source = found.at(-1) ?? error.split(/\n\s*\n/).find((part) => part.trim()) ?? error;
  const one = source.replace(/\s+/g, " ").trim();
  return one.length > 280 ? `${one.slice(0, 279)}…` : one;
}

export function splitNote(text: string): { head: string; body: string } {
  const mark = text.match(/^(\S+) attempt (\d+) failed \(/);
  if (!mark) return { head: "", body: text.trim() };
  const body = text
    .slice(mark[0].length)
    .replace(/\)(?:; [\s\S]*)?\.?\s*$/, "")
    .trim();
  return { head: `${mark[1]} 第 ${mark[2]} 次失敗`, body };
}

export type ResultRow = { kind: "title" | "label" | "fact" | "text"; text: string; extra?: string };

/** The first lines of a result file, without the markdown marks. */
export function resultRows(lines: string[]): ResultRow[] {
  return lines.map((line) => {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const level = heading?.[1];
    if (heading && level) {
      const text = (heading[2] ?? "").replace(/\*\*/g, "").trim();
      return { kind: level.length === 1 ? "title" : "label", text };
    }
    const fact = line.match(/^\*\*([^*]+):\*\*\s*(.*)$/);
    const label = fact?.[1];
    if (fact && label) {
      const value = fact[2] ?? "";
      return { kind: "fact", text: label.trim(), extra: DONE[value.trim().toLowerCase()] ?? value.trim() };
    }
    return { kind: "text", text: line.replace(/\*\*/g, "").replace(/`/g, "").trim() };
  });
}
