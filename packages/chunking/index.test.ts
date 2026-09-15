import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHUNK_SIZE,
  chunkData,
  reassembleChunks,
} from "./index.js";

describe("chunking engine (OPENSTORE-002)", () => {
  it("1. chunks small data into a single zero-based chunk", () => {
    const data = Buffer.from("hello openstore");
    const chunks = chunkData(data);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.index).toBe(0);
    expect(chunks[0]?.total).toBe(1);
    expect(chunks[0]?.data.equals(data)).toBe(true);
    expect(chunks[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic: same input yields identical chunks/hashes.
    expect(chunkData(data)[0]?.hash).toBe(chunks[0]?.hash);
  });

  it("2. splits data larger than 4 MiB into multiple chunks", () => {
    const data = Buffer.alloc(DEFAULT_CHUNK_SIZE + 1024, 0xab);
    const chunks = chunkData(data);

    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1]);
    expect(chunks.every((chunk) => chunk.total === 2)).toBe(true);
    expect(chunks[0]?.data.length).toBe(DEFAULT_CHUNK_SIZE);
  });

  it("3. maps an exact 4 MiB boundary to exactly one full chunk", () => {
    const data = Buffer.alloc(DEFAULT_CHUNK_SIZE, 0xcd);
    const chunks = chunkData(data);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.index).toBe(0);
    expect(chunks[0]?.data.length).toBe(DEFAULT_CHUNK_SIZE);
  });

  it("4. ends larger files with a partial final chunk", () => {
    const data = Buffer.alloc(DEFAULT_CHUNK_SIZE + 100, 0xef);
    const chunks = chunkData(data);

    expect(chunks).toHaveLength(2);
    expect(chunks[1]?.data.length).toBe(100);
  });

  it("5. reconstruction equals the original Buffer", () => {
    const cases = [
      Buffer.from("hello openstore"),
      Buffer.alloc(DEFAULT_CHUNK_SIZE, 0x11),
      Buffer.alloc(DEFAULT_CHUNK_SIZE + 1024, 0x22),
      Buffer.alloc(0),
    ];
    for (const original of cases) {
      expect(reassembleChunks(chunkData(original)).equals(original)).toBe(true);
    }
  });

  it("6. hash changes when chunk data changes", () => {
    const first = chunkData(Buffer.from("chunk-a"))[0]?.hash;
    const second = chunkData(Buffer.from("chunk-b"))[0]?.hash;
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);

    // Tampered bytes no longer match the recorded hash.
    const chunks = chunkData(Buffer.from("tamper me"));
    const tampered = {
      ...chunks[0]!,
      data: Buffer.from("tamper yo"),
    };
    expect(() => reassembleChunks([tampered])).toThrow();
  });

  it("7. rejects invalid ordering, duplicates, and missing chunks", () => {
    const data = Buffer.alloc(1024, 0x99);
    const chunks = chunkData(data, 256);
    expect(chunks).toHaveLength(4);

    // Out-of-order.
    expect(() => reassembleChunks([chunks[1]!, chunks[0]!, chunks[2]!, chunks[3]!])).toThrow();
    // Duplicate index.
    expect(() => reassembleChunks([chunks[0]!, chunks[0]!, chunks[2]!, chunks[3]!])).toThrow();
    // Missing middle chunk.
    expect(() => reassembleChunks([chunks[0]!, chunks[2]!, chunks[3]!])).toThrow();
    // Missing tail chunk (truncation detected via total).
    expect(() => reassembleChunks([chunks[0]!, chunks[1]!, chunks[2]!])).toThrow();
  });
});
