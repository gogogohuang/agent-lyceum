/** Host and Origin checks against DNS rebinding and cross-site `POST /quota`. Pure: no sockets, no node imports. */

export type GuardOptions = {
  /** The `--host` bind address. A non-loopback bind disables every check (the user chose to expose the server). */
  bindHost: string;
  /** Extra names from `--allow-host`. */
  allowHosts: readonly string[];
  /** The port the server is actually listening on. */
  port: number;
};

export type GuardRequest = { method: string | undefined; pathname: string; host: string | undefined; origin?: string | undefined };

const LOOPBACK_NAMES = ["127.0.0.1", "localhost", "::1"];

/** Trim, lowercase, drop `:port` or `[v6]:port` brackets and one trailing dot. Undefined when there is nothing usable. */
export function normalizeHost(value: string | undefined): string | undefined {
  let host = (value ?? "").trim().toLowerCase();
  if (!host) return undefined;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end < 0) return undefined;
    host = host.slice(1, end);
  } else if ((host.match(/:/g) ?? []).length === 1) {
    host = host.slice(0, host.indexOf(":"));
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host || undefined;
}

export function isLoopbackHost(host: string): boolean {
  const name = normalizeHost(host);
  if (!name) return false;
  return name === "localhost" || name === "::1" || /^127\.\d+\.\d+\.\d+$/.test(name);
}

function allowed(opts: GuardOptions): Set<string> {
  const names = new Set(LOOPBACK_NAMES);
  for (const name of [opts.bindHost, ...opts.allowHosts]) {
    const n = normalizeHost(name);
    if (n) names.add(n);
  }
  return names;
}

/** The HTTP status to reject with (400 or 403), or undefined when the request may proceed. */
export function checkRequest(req: GuardRequest, opts: GuardOptions): 400 | 403 | undefined {
  if (!isLoopbackHost(opts.bindHost)) return undefined;
  const names = allowed(opts);
  const host = normalizeHost(req.host);
  if (!host) return 400;
  if (!names.has(host)) return 403;
  if (req.method === "POST" && req.pathname === "/quota" && req.origin !== undefined) {
    if (req.origin === "null") return 403;
    let url: URL;
    try {
      url = new URL(req.origin);
    } catch {
      return 403;
    }
    if (url.protocol !== "http:") return 403;
    const name = normalizeHost(url.hostname);
    if (!name || !names.has(name)) return 403;
    if (Number(url.port || 80) !== opts.port) return 403;
  }
  return undefined;
}
