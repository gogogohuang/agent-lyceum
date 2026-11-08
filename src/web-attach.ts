import type { EventEmitter } from "node:events";
import http from "node:http";
import { WATCH_RESTART_EXIT, WEB_RESTART_MESSAGE } from "./code-change.js";
import { runMonitor, type MonitorDeps } from "./monitor-lifecycle.js";

export type HealthProbe = { kind: "ours"; pid: number; home: string } | { kind: "foreign" } | { kind: "timeout" };

export interface AttachedWebDeps {
  start: () => Promise<{ url: string; close: () => Promise<void> }>;
  /** The port that was asked for; `probeHealth` is called with it when binding fails because it is taken. */
  port: number;
  ppid: () => number;
  /** The parent pid recorded before anything was awaited. */
  startPpid: number;
  stdout: EventEmitter & { write: (chunk: string) => unknown; destroyed?: boolean; writable?: boolean };
  stdin: MonitorDeps["stdin"];
  onSignal: MonitorDeps["onSignal"];
  /** Writes one complete line (with its newline) to stderr. */
  writeErr: (line: string) => void;
  exit: (code: number) => void;
  fail: (message: string) => void;
  probeHealth: (port: number) => Promise<HealthProbe>;
  intervalMs: number;
  /** True once the code on disk changed (`watchCodeChange`). */
  changed?: () => boolean;
  /** Replaceable in tests. */
  monitor?: (d: MonitorDeps) => void;
}

const SIGNAL_CODES: [NodeJS.Signals, number][] = [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]];

/** Ask `GET /health` on a taken port who holds it. Aborts after 1 s; an aborted or silent holder is `timeout`. */
export async function probeHealth(port: number): Promise<HealthProbe> {
  const signal = AbortSignal.timeout(1000);
  return new Promise<HealthProbe>((resolve) => {
    const timeout = () => resolve({ kind: "timeout" });
    const req = http.get({ host: "127.0.0.1", port, path: "/health", signal }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 65_536) res.destroy();
      });
      res.on("error", () => (signal.aborted ? timeout() : resolve({ kind: "foreign" })));
      res.on("end", () => {
        try {
          const j = JSON.parse(body) as { app?: unknown; pid?: unknown; home?: unknown };
          if (j.app === "agent-lyceum-web" && typeof j.pid === "number") return resolve({ kind: "ours", pid: j.pid, home: String(j.home ?? "") });
        } catch {
          /* not ours */
        }
        resolve({ kind: "foreign" });
      });
    });
    req.on("error", () => (signal.aborted ? timeout() : resolve({ kind: "foreign" })));
  });
}

/**
 * `status --web --exit-with-parent`: the page lives and dies with the launcher.
 * The parent pid is checked before the server starts, stop signals are caught while it starts, and the server
 * is closed (never left behind) on every path that ends the process.
 */
export async function runAttachedWeb(d: AttachedWebDeps): Promise<void> {
  if (d.ppid() !== d.startPpid) return d.exit(129);

  let stopCode: number | undefined;
  let started = false;
  for (const [sig, code] of SIGNAL_CODES) {
    d.onSignal(sig, () => {
      if (!started) stopCode ??= code;
    });
  }
  d.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (!started && (e.code === "EPIPE" || e.code === "EIO")) stopCode ??= 0;
  });

  let page: { url: string; close: () => Promise<void> };
  try {
    page = await d.start();
  } catch (error) {
    const message = (error as Error).message;
    const taken = /already in use/.test(message);
    if (!taken) {
      d.writeErr(`status --web: ${message}\n`);
      return d.exit(1);
    }
    const holder = await d.probeHealth(d.port);
    if (holder.kind === "ours") d.writeErr(`status --web: port ${d.port} in use by agent-lyceum-web pid ${holder.pid} home ${holder.home}\n`);
    else if (holder.kind === "foreign") d.writeErr(`status --web: port ${d.port} in use by another program\n`);
    else d.writeErr(`status --web: port ${d.port} in use, no answer in 1 s\n`);
    return d.exit(1);
  }

  const closeThenExit = (code: number) => void page.close().then(() => d.exit(code), () => d.exit(code));
  if (stopCode !== undefined) return closeThenExit(stopCode);
  if (d.ppid() !== d.startPpid) return closeThenExit(129);
  started = true;

  d.stdout.write(`${page.url}\n`);

  let stopping = false;
  (d.monitor ?? runMonitor)({
    draw: () => {
      if (stopping) return;
      d.stdout.write("\n");
      if (d.changed?.()) {
        stopping = true;
        d.writeErr(`${WEB_RESTART_MESSAGE}\n`);
        closeThenExit(WATCH_RESTART_EXIT);
      }
    },
    intervalMs: d.intervalMs,
    stdout: d.stdout,
    stdin: d.stdin,
    ppid: d.ppid,
    startPpid: d.startPpid,
    exit: closeThenExit,
    onSignal: d.onSignal,
    fail: d.fail,
  });
}
