import type { Mail } from "../types";

const TYPE: Record<string, string> = {
  task: "任務",
  reply: "回覆",
  done: "完成回報",
  ask: "提問",
  failure: "失敗",
};

export function MailBody({ mail }: { mail: Mail }) {
  const sections = mail.digest?.length ? mail.digest : mail.brief ? [{ label: "摘要", lines: [mail.brief] }] : [];
  return (
    <article className="mt-4 max-w-xl">
      <p className="text-sm text-ink/60">
        {TYPE[mail.type] ?? mail.type}，來自 {mail.from}
      </p>
      <p className="text-pretty mt-1 font-serif text-lg leading-snug">{mail.subject}</p>
      {mail.held && <p className="text-pretty mt-1 text-sm text-ink/70">這封在等空閒的實例。</p>}
      {sections.length > 0 && (
        <dl className="mt-3">
          {sections.map((section) => (
            <div key={section.label} className="mt-2 flex gap-3 first:mt-0">
              <dt className="w-20 shrink-0 text-pretty text-sm text-ink/60">{section.label}</dt>
              <dd className="min-w-0">
                {section.lines.map((line, index) => (
                  <p key={`${index}-${line}`} className="text-pretty font-serif text-base leading-relaxed">
                    {line}
                  </p>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  );
}
