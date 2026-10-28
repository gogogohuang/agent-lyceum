import type { Run } from "../types";
import { cacheText, tokenRows, tokenText } from "./view";

export function TokenChart({ run }: { run?: Run }) {
  const rows = tokenRows(run);
  const max = Math.max(1, ...rows.map((row) => row.output));
  const cache = cacheText(run?.cache_read_tokens ?? 0, run?.cache_write_tokens ?? 0);
  return (
    <section className="mt-10">
      <h2 className="text-balance text-xl">Token 與快取</h2>
      {rows.length === 0 ? (
        <p className="text-pretty mt-3 text-sm">還沒有 token 紀錄。</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {rows.map((row) => (
            <li key={row.agent}>
              <div className="flex justify-between gap-3 text-sm">
                <span className="truncate">{row.agent}</span>
                <span className="shrink-0 tabular-nums text-ink/70">
                  {tokenText(row.output)}
                  {row.cacheRead + row.cacheWrite > 0 ? `，快取讀 ${tokenText(row.cacheRead)}` : ""}
                  {row.failed > 0 ? `，失敗 ${row.failed}` : ""}
                </span>
              </div>
              <div className="mt-1 h-2 bg-line" title={`輸出 ${row.output}，快取讀 ${row.cacheRead}，寫 ${row.cacheWrite}`}>
                <div className="h-full bg-ink" style={{ width: `${(row.output / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="text-pretty mt-3 text-sm text-ink/70">{cache || "這個 run 沒有快取紀錄（Codex 與較舊的 run 不會有）。"}</p>
      <p className="text-pretty text-sm text-ink/70">長條是輸出 token，相對輸出最多的 agent。</p>
    </section>
  );
}
