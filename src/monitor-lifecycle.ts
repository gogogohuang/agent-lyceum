import type { EventEmitter } from "node:events";

export interface MonitorDeps {
  draw: () => void;
  intervalMs: number;
  stdout: EventEmitter & { destroyed?: boolean; writable?: boolean };
  stdin: EventEmitter & { isTTY?: boolean; resume: () => unknown };
  ppid: () => number;
  exit: (code: number) => void;
  onSignal: (sig: NodeJS.Signals, handler: () => void) => void;
  fail: (message: string) => void;
}

const SIGNAL_CODES: [NodeJS.Signals, number][] = [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]];

/** Run `draw` every interval and end the process when the monitor is closed: signal, dead stdout, TTY stdin close, or lost parent. */
export function runMonitor(d: MonitorDeps): void {
  const startPpid = d.ppid();
  let timer: NodeJS.Timeout | undefined;
  let done = false;
  const stop = (code: number) => {
    if (done) return;
    done = true;
    if (timer) clearInterval(timer);
    d.exit(code);
  };

  for (const [sig, code] of SIGNAL_CODES) d.onSignal(sig, () => stop(code));

  d.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE" || e.code === "EIO") return stop(0);
    done = true;
    if (timer) clearInterval(timer);
    d.fail(e.message);
  });

  if (d.stdin.isTTY) {
    for (const ev of ["end", "close", "error"]) d.stdin.on(ev, () => stop(0));
    d.stdin.resume(); // a TTY only reports EOF while it is being read
  }

  const tick = () => {
    if (done) return;
    if (d.ppid() !== startPpid) return stop(129);
    if (d.stdout.destroyed || d.stdout.writable === false) return stop(0);
    d.draw();
  };
  tick();
  if (!done) timer = setInterval(tick, d.intervalMs);
}
