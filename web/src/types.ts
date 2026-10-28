export type DigestSection = { label: string; lines: string[] };

export type Mail = {
  from: string;
  type: string;
  subject: string;
  brief?: string;
  digest?: DigestSection[];
  held?: true;
};

export type Sent = { to: string; type: string; subject: string };

export type Wake = {
  round: number;
  agent: string;
  at: string;
  duration_ms: number;
  ok: boolean;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  handling?: Mail[];
  sent?: Sent[];
  error?: string;
  runtime?: string;
  model?: string;
  fallback_from?: string;
  kind?: string;
  tier?: string | number;
};

export type Step = { text: string; done: boolean };

export type Run = {
  run_id: string;
  name?: string;
  state: "running" | "interrupted" | "ended" | "waiting";
  /** False when the dispatcher process is gone. A running state can still say this. */
  live?: boolean;
  end_reason?: string;
  outcome?: string;
  outcome_verified: boolean;
  outcome_note?: string;
  started_at: string;
  ended_at?: string;
  rounds: number;
  max_rounds: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  task_summary: string;
  steps?: Step[];
  current_step: string | null;
  active: Record<string, { since: string; round?: number; handling?: Mail[] }>;
  queue: (Mail & { agent: string })[];
  wakes: Wake[];
  notes?: string[];
  blocked_integrations?: { agent: string; branch: string; reason: string; report: string }[];
  result_head?: string[];
  failure?: { agent: string; error?: string; attempts: number };
  ask?: { path: string; total: number; unanswered: number };
  instances?: Record<string, string[]>;
};

export type Agent = {
  name: string;
  runtime?: string;
  lead: boolean;
  role?: string;
  instance?: number;
  unread: number;
  can_message?: string[];
  last_wake?: { at: string; ok: boolean; error?: string };
  model?: string;
  fallback?: { from: string; kind: string };
  cooldowns?: { model: string; kind: string; remaining_sec: number }[];
};

export type StatusReport = {
  schema_version: 1;
  project: { name: string; dir: string; lead: string };
  agents: Agent[];
  run?: Run;
  memory_advice?: string[];
};

/** One line of `status --json --watch`, unchanged. The web stream only wraps it. */
export type WatchFrame = {
  schema_version: 1;
  report?: StatusReport;
  runs?: Record<string, StatusReport>;
  error?: string;
};

export type QuotaWindow = { label: string; used_percent: number; remaining_percent: number; resets: string };
export type QuotaReport = { runtime: "claude" | "codex"; windows: QuotaWindow[]; error?: string };

export type WebEvent =
  | { type: "snapshot"; projects: { name: string; frame: WatchFrame }[]; quota?: QuotaReport[] }
  | { type: "frame"; name: string; frame: WatchFrame }
  | { type: "removed"; name: string }
  | { type: "quota"; reports: QuotaReport[] };
