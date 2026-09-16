import { describe, expect, it } from "vitest";
import { MixedStorageTransport } from "./http-transport.js";

describe("mixed storage transport (OPENSTORE-038)", () => {
  it("routes HTTP and libp2p endpoints explicitly without downgrade", async () => {
    const transport = new MixedStorageTransport();
    await expect(transport.health(
      { nodeId: "http", baseUrl: "http://127.0.0.1:1" },
      { timeoutMs: 20 },
    )).rejects.toThrow();
    await expect(transport.health(
      { nodeId: "bad", baseUrl: "ftp://example.test" },
      { timeoutMs: 20 },
    )).rejects.toThrow(/unsupported storage transport/i);
  });
});
