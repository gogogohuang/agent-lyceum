import { useState } from "react";
import { COMMANDS, type CommandId } from "../commands";
import { CommandDialog } from "./CommandDialog";

const TOOLS: { id: CommandId; blurb: string }[] = [
  { id: "project.add", blurb: "把一個 repo 註冊成專案。" },
  { id: "project.remove", blurb: "取消註冊；預設保留 context。" },
  { id: "call", blurb: "不開專案，直接請全域 library 的某位 agent 做一件事。" },
  { id: "clear.lock", blurb: "run 當掉後留下的鎖，確認沒人在跑再清。" },
  { id: "demo", blurb: "在沙盒裡跑一次完整示範。" },
  { id: "init", blurb: "建立 home 與預設的全域 agent library。" },
];

export function ToolsPage({ projects }: { projects: string[] }) {
  const [open, setOpen] = useState<CommandId>();
  return (
    <article className="enter animate-in fade-in p-4 duration-200 sm:p-6">
      <h1 className="text-balance text-2xl font-semibold tracking-tight">工具</h1>
      <p className="text-pretty mt-2 text-sm">專案內的操作（新任務、續跑、回答問題…）在各專案頁面上。這裡放不屬於單一專案的。</p>
      <ul className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {TOOLS.map((t) => (
          <li key={t.id} className="panel flex flex-col gap-3 p-4">
            <h2 className="font-medium">{COMMANDS[t.id].label}</h2>
            <p className="text-pretty text-sm text-ink/70">{t.blurb}</p>
            <button
              type="button"
              className="mt-auto min-h-11 self-start rounded-lg border border-line bg-paper px-4 text-sm hover:bg-wall focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
              onClick={() => setOpen(t.id)}
            >
              {COMMANDS[t.id].label}…
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <CommandDialog
          id={open}
          open
          fieldOptions={open === "project.remove" ? { name: projects } : open === "clear.lock" ? { project: projects } : undefined}
          onClose={() => setOpen(undefined)}
        />
      )}
    </article>
  );
}
