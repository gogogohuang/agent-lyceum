/** Self-scheduling poller: the next tick starts only after the previous request settled, so requests never overlap. Late results after stop() are ignored. */
export function startPoll<T>(fetcher: () => Promise<T>, onResult: (value: T) => void, ms: number): () => void {
  let live = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    let value: T | undefined;
    let ok = true;
    try {
      value = await fetcher();
    } catch {
      ok = false;
    }
    if (!live) return;
    if (ok) onResult(value as T);
    timer = setTimeout(() => void tick(), ms);
  };
  void tick();
  return () => {
    live = false;
    if (timer !== undefined) clearTimeout(timer);
  };
}
