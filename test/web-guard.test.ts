import { describe, expect, it } from "vitest";
import { checkRequest, isLoopbackHost, normalizeHost } from "../web/src/server/guard.js";

const base = { port: 8787, bindHost: "127.0.0.1", allowHosts: [] as string[] };
const get = (host: string | undefined, over = {}) => checkRequest({ method: "GET", pathname: "/", host, ...over }, base);
const post = (origin: string | undefined, over = {}) => checkRequest({ method: "POST", pathname: "/quota", host: "127.0.0.1:8787", origin, ...over }, base);

describe("normalizeHost", () => {
  it("lowercases, strips port, brackets and one trailing dot", () => {
    expect(normalizeHost(" LOCALHOST:8787 ")).toBe("localhost");
    expect(normalizeHost("[::1]:8787")).toBe("::1");
    expect(normalizeHost("localhost.")).toBe("localhost");
    expect(normalizeHost("localhost..")).toBe("localhost.");
    expect(normalizeHost("127.0.0.1")).toBe("127.0.0.1");
  });
  it("returns undefined when empty or unparsable", () => {
    expect(normalizeHost(undefined)).toBeUndefined();
    expect(normalizeHost("  ")).toBeUndefined();
    expect(normalizeHost("[::1")).toBeUndefined();
    expect(normalizeHost(":8787")).toBeUndefined();
  });
});

describe("Host check", () => {
  it("rejects an unknown host with 403", () => expect(get("evil.example")).toBe(403));
  it("passes loopback names in any case, with port, bracketed v6, trailing dot", () => {
    for (const h of ["LOCALHOST:8787", "127.0.0.1:8787", "[::1]:8787", "localhost.", "::1"]) expect(get(h)).toBeUndefined();
  });
  it("a missing or unparsable Host is 400", () => {
    expect(get(undefined)).toBe(400);
    expect(get("")).toBe(400);
    expect(get("[::1")).toBe(400);
  });
  it("--host value and --allow-host values are allowed", () => {
    expect(checkRequest({ method: "GET", pathname: "/", host: "mybox.local:8787" }, { ...base, allowHosts: ["mybox.local"] })).toBeUndefined();
    expect(checkRequest({ method: "GET", pathname: "/", host: "mybox.local:8787" }, base)).toBe(403);
    expect(checkRequest({ method: "GET", pathname: "/", host: "127.0.0.2:1" }, { ...base, bindHost: "127.0.0.2" })).toBeUndefined();
  });
  it("is skipped when --host is not loopback", () => {
    expect(checkRequest({ method: "GET", pathname: "/", host: "evil.example" }, { ...base, bindHost: "0.0.0.0" })).toBeUndefined();
    expect(checkRequest({ method: "POST", pathname: "/quota", host: "x", origin: "null" }, { ...base, bindHost: "0.0.0.0" })).toBeUndefined();
  });
  it("loopback detection", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of ["0.0.0.0", "::", "192.168.1.2", "example.com"]) expect(isLoopbackHost(h)).toBe(false);
  });
});

describe("Origin check (POST /quota only)", () => {
  it("no Origin passes", () => expect(post(undefined)).toBeUndefined());
  it("null, foreign, unparsable, non-http are 403", () => {
    expect(post("null")).toBe(403);
    expect(post("http://evil.example")).toBe(403);
    expect(post("::::")).toBe(403);
    expect(post("https://127.0.0.1:8787")).toBe(403);
  });
  it("same host and server port passes; other port is 403", () => {
    expect(post("http://127.0.0.1:8787")).toBeUndefined();
    expect(post("http://LOCALHOST.:8787")).toBeUndefined();
    expect(post("http://[::1]:8787")).toBeUndefined();
    expect(post("http://127.0.0.1:9999")).toBe(403);
    expect(post("http://127.0.0.1")).toBe(403); // default port 80 is not the server port
  });
  it("is not applied to other routes", () => {
    expect(checkRequest({ method: "GET", pathname: "/events", host: "127.0.0.1:8787", origin: "http://evil.example" }, base)).toBeUndefined();
  });
  it("an allowed custom host works as an Origin", () => {
    expect(checkRequest({ method: "POST", pathname: "/quota", host: "mybox.local:8787", origin: "http://mybox.local:8787" }, { ...base, allowHosts: ["mybox.local"] })).toBeUndefined();
  });
});
