/** The parent pid when the process started (read at module load, before config loading and preflight). */
export const LAUNCH_PPID: number = process.ppid;

/**
 * Started by a launcher that does not relay SIGHUP: npm/npx/pnpm/yarn (they set `npm_execpath`), or the tsx CLI
 * (its child runs with `--require …/tsx/dist/preflight.cjs`). A directly run binary is never watched, so runs that are
 * detached on purpose (`&`, `disown`, `setsid`, supervisors) keep running when their parent exits.
 */
export function startedByWrapper(env: NodeJS.ProcessEnv = process.env, execArgv: readonly string[] = process.execArgv): boolean {
  if (env.npm_execpath) return true;
  return execArgv.some((a) => /[\\/]tsx[\\/]dist[\\/]preflight\.cjs$/.test(a));
}

/**
 * Call `onGone` once when the parent pid differs from `startPpid` (the launcher exited and the process was adopted):
 * checked at once, then every `intervalMs` on an unref'd timer. Returns a function that stops the watch.
 */
export function watchParent(onGone: () => void, opts: { startPpid: number; ppid?: () => number; intervalMs?: number }): () => void {
  const ppid = opts.ppid ?? (() => process.ppid);
  let timer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  if (ppid() !== opts.startPpid) {
    onGone();
    return stop;
  }
  timer = setInterval(() => {
    if (ppid() === opts.startPpid) return;
    stop();
    onGone();
  }, opts.intervalMs ?? 1000);
  timer.unref();
  return stop;
}
