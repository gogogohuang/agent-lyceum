export const WATCH_RESTART_PREFIX = "status --watch: agent-lyceum code changed on disk";
export const isWatchRestart = (why: string): boolean => why.startsWith(WATCH_RESTART_PREFIX);
export const MAX_RESTARTS = 5;
export const RESTART_WINDOW_MS = 60_000;

export interface WatchRestartDeps {
  follow: () => Promise<string>;
  startPolling: () => void;
  log: (line: string) => void;
  /** Monotonic milliseconds. */
  now: () => number;
}

/** Await each child before replacing it; register polling exactly once on fallback. */
export async function superviseWatch(d: WatchRestartDeps): Promise<void> {
  const restarts: number[] = [];
  for (;;) {
    let why: string;
    let ended = false;
    try {
      why = await d.follow();
      ended = true;
    } catch (e) {
      why = e instanceof Error ? e.message : String(e);
    }
    const marker = ended && isWatchRestart(why);
    const t = d.now();
    while (restarts.length && t - restarts[0]! > RESTART_WINDOW_MS) restarts.shift();
    if (marker && restarts.length < MAX_RESTARTS) {
      restarts.push(t);
      d.log(`agent-lyceum changed; restarting status --watch (${restarts.length}/${MAX_RESTARTS} in ${RESTART_WINDOW_MS / 1000}s)`);
      continue;
    }
    d.log(marker ? "restart limit reached; polling" : `${why}; polling`);
    d.startPolling();
    return;
  }
}
