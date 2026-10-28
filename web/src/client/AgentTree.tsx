import { Collapsible } from "@base-ui/react/collapsible";
import { motion, useInView, useReducedMotion } from "motion/react";
import { useRef } from "react";
import type { Agent, Mail, Run } from "../types";
import { cn } from "./cn";
import { MailBody } from "./MailBody";
import { readableError } from "./prose";
import { agentDot, agentLabel, elapsed, latestEdge, memberLink, orderedAgents, recentMail, tokenText } from "./view";

export function AgentTree({ agents, run, now }: { agents: Agent[]; run?: Run; now: number }) {
  const ordered = orderedAgents(agents, run);
  const lead = ordered.find((agent) => agent.lead);
  const members = ordered.filter((agent) => !agent.lead);
  const edge = latestEdge(run);
  const recent = recentMail(run);
  const live = run?.state === "running";
  return (
    <section className="mt-10">
      <h2 className="text-balance text-xl">隊伍</h2>
      {ordered.length === 0 ? (
        <p className="text-pretty mt-3 text-sm">沒有 agent。</p>
      ) : (
        <>
          <p className="text-pretty mt-2 text-sm text-ink/70">連線是誰可以傳話給誰。▼ 往下，▲ 往上，↕ 雙方。{live ? "會移動的是最近一次交接。" : ""}</p>
          <div className="mt-6 max-w-2xl">
            {lead && <Card agent={lead} run={run} now={now} />}
            {members.length > 0 && (
              <ul className="mt-1 list-none border-l border-line p-0">
                {members.map((agent) => {
                  const link = lead ? memberLink(lead, agent, edge) : undefined;
                  return (
                    <li key={agent.name} className="relative pl-8">
                      {link && lead ? <LinkMark glyph={link.glyph} hot={link.hot} live={live} title={tieTitle(lead, agent, link)} /> : <div className="h-8" />}
                      <Card agent={agent} run={run} now={now} />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
      {recent.length > 0 && (
        <ol className="mt-6 max-w-xl space-y-3 text-sm">
          {recent.map((item) => (
            <li key={`${item.from}-${item.to}-${item.subject}`}>
              <p className="text-ink/60">{item.to === "(done)" ? `${item.from} 結束` : `${item.from} 給 ${item.to}`}</p>
              <p className="text-pretty mt-0.5 font-serif leading-snug">{item.subject}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function LinkMark({ glyph, hot, live, title }: { glyph: "▼" | "▲" | "↕"; hot: boolean; live: boolean; title: string }) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.5 });
  const play = live && !reduce && inView;
  const moving = play && hot;
  return (
    <div ref={ref} title={title} className="absolute top-0 -left-8 flex size-8 items-center justify-center">
      {live && glyph !== "▲" && <Flow y={[0, 18]} hot={hot} play={play} />}
      {live && glyph !== "▼" && <Flow y={[18, 0]} hot={hot} play={play} />}
      <motion.span
        className={cn("relative text-sm", moving ? "text-signal" : "text-ink/50")}
        animate={moving ? { y: glyph === "▲" ? [0, -3, 0] : [0, 3, 0] } : { y: 0 }}
        transition={moving ? { duration: 0.85, repeat: Infinity, ease: "easeOut" } : { duration: 0.2, ease: "easeOut" }}
      >
        {glyph}
      </motion.span>
    </div>
  );
}

function Flow({ y, hot, play }: { y: [number, number]; hot: boolean; play: boolean }) {
  return (
    <motion.span
      aria-hidden
      className={cn("absolute left-1/2 size-1.5 -translate-x-1/2 rounded-full", hot ? "bg-signal" : "bg-ink/30")}
      initial={false}
      animate={play ? { y, opacity: [0, 1, 0] } : { y: (y[0] + y[1]) / 2, opacity: hot ? 0.85 : 0.35 }}
      transition={play ? { duration: hot ? 1.1 : 2.8, repeat: Infinity, ease: "linear" } : { duration: 0.2, ease: "easeOut" }}
    />
  );
}

function Card({ agent, run, now }: { agent: Agent; run?: Run; now: number }) {
  const dot = agentDot(agent, run);
  const working = dot === "active";
  const active = run?.state === "running" ? run.active[agent.name] : undefined;
  const queued = dot === "queued" ? (run?.queue ?? []).filter((item) => item.agent === agent.name).length : 0;
  const wakes = (run?.wakes ?? []).filter((wake) => wake.agent === agent.name);
  const failed = wakes.filter((wake) => !wake.ok).length;
  const tokens = wakes.reduce((sum, wake) => sum + (wake.output_tokens ?? 0), 0);
  const mails = mailsOf(agent, run, dot);
  return (
    <Collapsible.Root key={working ? `${agent.name}:on` : agent.name} defaultOpen={working} className={cn("group border-b border-line", working && "border-l-2 border-signal pl-4")}>
      <Collapsible.Trigger className="flex w-full items-baseline gap-3 py-3 text-left">
        <strong className={cn("min-w-0 flex-1", working ? "text-balance text-lg" : "truncate text-base text-ink/80")}>{agentLabel(agent)}</strong>
        <span className={cn("shrink-0 text-sm tabular-nums", statusColor(dot))}>{statusLine(dot, active?.round, active ? elapsed(active.since, now) : "", queued)}</span>
        <span className="shrink-0 text-sm text-ink/60 group-data-[open]:hidden">展開</span>
        <span className="hidden shrink-0 text-sm text-ink/60 group-data-[open]:inline">收合</span>
      </Collapsible.Trigger>
      <Collapsible.Panel className="pb-4 text-sm">
        <dl className="mt-1">
          <Fact label="執行" value={`${agent.lead ? "帶隊，" : ""}${agent.runtime ?? "?"}`} />
          {(agent.model || agent.fallback) && <Fact label="模型" value={agent.fallback ? `備援中 ${agent.model ?? ""}` : (agent.model ?? "")} />}
          <Fact label="token" value={tokenText(tokens)} />
          <Fact label="喚醒" value={`${wakes.length} 次${failed > 0 ? `，失敗 ${failed}` : ""}`} />
          {agent.unread > 0 && <Fact label="未看" value={String(agent.unread)} />}
          <div className="mt-1 flex gap-3">
            <dt className="w-20 shrink-0 text-ink/60">可傳話給</dt>
            <dd className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
              {(agent.can_message ?? []).length > 0 ? (agent.can_message ?? []).map((name) => <span key={name}>{name}</span>) : "沒有人"}
            </dd>
          </div>
        </dl>
        {dot === "failed" && agent.last_wake?.error && <p className="text-pretty mt-3 max-w-xl text-sm leading-relaxed text-failed">{readableError(agent.last_wake.error)}</p>}
        {mails.map((mail, index) => (
          <MailBody key={`${index}-${mail.from}-${mail.subject}`} mail={mail} />
        ))}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="mt-1 flex gap-3 first:mt-0">
      <dt className="w-20 shrink-0 text-ink/60">{label}</dt>
      <dd className="min-w-0 text-pretty tabular-nums">{value}</dd>
    </div>
  );
}

function mailsOf(agent: Agent, run: Run | undefined, dot: ReturnType<typeof agentDot>): Mail[] {
  if (!run) return [];
  if (dot === "active") return run.active[agent.name]?.handling ?? [];
  if (dot === "queued") return (run.queue ?? []).filter((item) => item.agent === agent.name);
  return [];
}

function statusLine(dot: ReturnType<typeof agentDot>, round: number | undefined, elapsedText: string, queued: number): string {
  if (dot === "active") return `進行中${round ? ` #${round}` : ""} ${elapsedText}`.trim();
  if (dot === "failed") return "上次喚醒失敗";
  if (dot === "queued") return `排隊 ${queued} 封`;
  return "閒置";
}

function statusColor(dot: ReturnType<typeof agentDot>): string {
  if (dot === "active") return "text-working";
  if (dot === "failed") return "text-failed";
  return "text-ink/60";
}

function tieTitle(lead: Agent, member: Agent, link: { glyph: "▼" | "▲" | "↕"; hot: boolean }): string {
  const who = link.glyph === "▼" ? `${lead.name} 可傳給 ${member.name}` : link.glyph === "▲" ? `${member.name} 可傳給 ${lead.name}` : `${lead.name} 與 ${member.name} 可互傳`;
  return link.hot ? `${who}，最近一次交接` : who;
}
