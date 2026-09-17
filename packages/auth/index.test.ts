import { describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import { createAuthHeaders, verifyAuthHeaders } from "./index.js";

describe("bounded replay protection", () => {
  it("accepts normal nonces and rejects replays", () => {
    const identity = createIdentity();
    const headers = createAuthHeaders(identity, "GET", "/test");
    const cache = new Map<string, number>();

    expect(verifyAuthHeaders(headers, "GET", "/test", undefined, 300_000, cache, 2)).toEqual({ valid: true });
    expect(verifyAuthHeaders(headers, "GET", "/test", undefined, 300_000, cache, 2)).toEqual({
      valid: false,
      error: "replayed nonce",
    });
  });

  it("removes expired entries before applying the size bound", () => {
    const identity = createIdentity();
    const cache = new Map<string, number>([["expired", Date.now() - 1]]);
    const headers = createAuthHeaders(identity, "GET", "/fresh");

    expect(verifyAuthHeaders(headers, "GET", "/fresh", undefined, 300_000, cache, 1).valid).toBe(true);
    expect(cache.size).toBe(1);
    expect(cache.has("expired")).toBe(false);
  });

  it("evicts the oldest entry while retaining the newest valid request", () => {
    const identity = createIdentity();
    const cache = new Map<string, number>();
    const requests = ["1", "2", "3"].map((suffix, index) => createAuthHeaders(
      identity,
      "GET",
      `/request-${suffix}`,
      undefined,
      { nonce: suffix.repeat(32), timestamp: Date.now() + index },
    ));

    expect(verifyAuthHeaders(requests[0]!, "GET", "/request-1", undefined, 300_000, cache, 2).valid).toBe(true);
    expect(verifyAuthHeaders(requests[1]!, "GET", "/request-2", undefined, 300_000, cache, 2).valid).toBe(true);
    expect(verifyAuthHeaders(requests[2]!, "GET", "/request-3", undefined, 300_000, cache, 2).valid).toBe(true);
    expect(cache.size).toBe(2);
    expect(verifyAuthHeaders(requests[1]!, "GET", "/request-2", undefined, 300_000, cache, 2).error).toBe("replayed nonce");
    expect(verifyAuthHeaders(requests[0]!, "GET", "/request-1", undefined, 300_000, cache, 2).valid).toBe(true);
  });

  it("rejects invalid cache limits", () => {
    const identity = createIdentity();
    const headers = createAuthHeaders(identity, "GET", "/test");
    expect(() => verifyAuthHeaders(headers, "GET", "/test", undefined, 300_000, new Map(), 0)).toThrow(/positive safe integer/);
  });
});
