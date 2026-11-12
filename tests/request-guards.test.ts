import { afterEach, describe, expect, it, vi } from "vitest";
import { samePagePath } from "../src/lib/next-path";
import { sheetTokenOk, tokenMatches } from "../src/lib/sheet-token";

describe("after signing in", () => {
  it("goes to a path on this site, keeping its query and anchor", () => {
    expect(samePagePath("/inventory?view=free#top")).toBe("/inventory?view=free#top");
    expect(samePagePath("/")).toBe("/");
  });

  it("never leaves the site, however the address is dressed up", () => {
    for (const next of ["//evil.com", "/\\evil.com", "/\t/evil.com", "/\n/evil.com", "https://evil.com", "evil.com", "javascript:alert(1)", ""]) {
      expect([next, samePagePath(next)]).toEqual([next, "/"]);
    }
  });
});

describe("webhook and feed tokens", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("match only the exact token", () => {
    expect(tokenMatches("abc123", "abc123")).toBe(true);
    expect(tokenMatches("abc124", "abc123")).toBe(false);
    expect(tokenMatches("abc", "abc123")).toBe(false);
    expect(tokenMatches("abc123", undefined)).toBe(false);
    expect(tokenMatches("", "")).toBe(false);
  });

  it("say no, rather than fail, to a token with other characters in it", () => {
    // Same length in characters, longer in bytes.
    expect(tokenMatches("abc12é", "abc123")).toBe(false);
  });

  it("keep the sheet feeds closed until a long enough token is set", () => {
    vi.stubEnv("SHEET_SYNC_TOKEN", "short");
    expect(sheetTokenOk("short")).toBe(false);
    vi.stubEnv("SHEET_SYNC_TOKEN", "a".repeat(16));
    expect(sheetTokenOk("a".repeat(16))).toBe(true);
  });
});
