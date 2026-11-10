/** Host and Origin checks against DNS rebinding and cross-site writes. Pure: no sockets, no node imports. */

export type GuardOptions = {
  /** The `--host` bind address. A non-loopback bind disables every check (the user chose to expose the server). */
  bindHost: string;
  /** Extra names from `--allow-host`. */
  allowHosts: readonly string[];
  /** The port the server is actually listening on. */
  port: number;
  /** The CSRF token every `POST /api/*` must send. */
  token?: string;
};

export type GuardRequest = { method: string | undefined; pathname: string; host: string | undefined; origin?: string | undefined; token?: string | undefined };

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

function sameOrigin(origin: string, names: Set<string>, port: number): boolean {
  if (origin === "null") return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  const name = normalizeHost(url.hostname);
  if (!name || !names.has(name)) return false;
  return Number(url.port || 80) === port;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The HTTP status to reject with (400 or 403), or undefined when the request may proceed. */
export function checkRequest(req: GuardRequest, opts: GuardOptions): 400 | 403 | undefined {
  const apiWrite = req.method === "POST" && req.pathname.startsWith("/api/");
  if (!isLoopbackHost(opts.bindHost)) return apiWrite ? 403 : undefined;
  const names = allowed(opts);
  const host = normalizeHost(req.host);
  if (!host) return 400;
  if (!names.has(host)) return 403;
  if (apiWrite) {
    if (req.origin === undefined || !sameOrigin(req.origin, names, opts.port)) return 403;
    if (!opts.token || !req.token || !safeEqual(req.token, opts.token)) return 403;
    return undefined;
  }
  if (req.method === "POST" && req.pathname === "/quota" && req.origin !== undefined) {
    if (!sameOrigin(req.origin, names, opts.port)) return 403;
  }
  return undefined;
}
