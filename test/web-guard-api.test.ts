import { describe, expect, it } from "vitest";
import { checkRequest } from "../web/src/server/guard.js";

const opts = { port: 8787, bindHost: "127.0.0.1", allowHosts: [] as string[], token: "tok-123" };
const post = (over: Record<string, unknown> = {}, o = opts) =>
  checkRequest({ method: "POST", pathname: "/api/cmd/run", host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787", token: "tok-123", ...over } as Parameters<typeof checkRequest>[0], o);

describe("POST /api/*", () => {
  it("passes with Host, same-origin Origin and the token", () => expect(post()).toBeUndefined());
  it("a missing Origin is refused (unlike /quota)", () => expect(post({ origin: undefined })).toBe(403));
  it("a cross-site or opaque Origin is refused", () => {
    expect(post({ origin: "http://evil.example" })).toBe(403);
    expect(post({ origin: "null" })).toBe(403);
    expect(post({ origin: "http://127.0.0.1:9999" })).toBe(403);
  });
  it("a missing or wrong token is refused", () => {
    expect(post({ token: undefined })).toBe(403);
    expect(post({ token: "tok-124" })).toBe(403);
    expect(post({ token: "tok" })).toBe(403);
  });
  it("no server token configured refuses everything", () => expect(post({}, { ...opts, token: undefined } as typeof opts)).toBe(403));
  it("an unknown Host still gets the Host answer first", () => {
    expect(post({ host: "evil.example" })).toBe(403);
    expect(post({ host: undefined })).toBe(400);
  });
  it("a non-loopback bind disables the write API outright", () => {
    expect(post({ host: "0.0.0.0:8787" }, { ...opts, bindHost: "0.0.0.0" })).toBe(403);
  });
  it("GET /api/* only needs the Host check", () => {
    expect(checkRequest({ method: "GET", pathname: "/api/jobs", host: "127.0.0.1:8787" }, opts)).toBeUndefined();
  });
  it("POST /quota keeps its old rules: Origin optional", () => {
    expect(checkRequest({ method: "POST", pathname: "/quota", host: "127.0.0.1:8787" }, opts)).toBeUndefined();
    expect(checkRequest({ method: "POST", pathname: "/quota", host: "127.0.0.1:8787", origin: "http://evil.example" }, opts)).toBe(403);
  });
});
