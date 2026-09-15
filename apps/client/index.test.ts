import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { createStorageNode } from "../storage-node/index.js";
import type { StorageNode } from "../storage-node/index.js";
import { getPieceFromNodes, storePieceOnNodes } from "./index.js";
import type { StorageNodeEndpoint } from "./index.js";

const nodes: StorageNode[] = [];
let endpoints: StorageNodeEndpoint[] = [];
const deadA: StorageNodeEndpoint = {
  id: "node-dead-a",
  baseUrl: "http://127.0.0.1:1",
};
const deadB: StorageNodeEndpoint = {
  id: "node-dead-b",
  baseUrl: "http://127.0.0.1:2",
};

beforeAll(async () => {
  for (const id of ["node-a", "node-b", "node-c"]) {
    const dir = await mkdtemp(join(tmpdir(), `openstore-${id}-`));
    const node = createStorageNode({ storageDir: dir });
    const port = await node.listen(0, "127.0.0.1");
    nodes.push(node);
    endpoints.push({ id, baseUrl: `http://127.0.0.1:${port}` });
  }
});

afterAll(async () => {
  for (const node of nodes) {
    await node.close();
  }
  for (const node of nodes) {
    await rm(node.storageDir, { recursive: true, force: true });
  }
});

async function storedOn(
  endpoint: StorageNodeEndpoint,
  pieceId: string,
): Promise<Buffer | null> {
  const res = await fetch(`${endpoint.baseUrl}/pieces/${pieceId}`);
  if (res.status !== 200) {
    return null;
  }
  return Buffer.from(await res.arrayBuffer());
}

describe("local multi-node storage (OPENSTORE-004)", () => {
  it("1. stores a piece on 3 nodes", async () => {
    const bytes = Buffer.from("replicated-piece-001");
    const report = await storePieceOnNodes("multi-001", bytes, endpoints);

    expect(report.succeeded.map((e) => e.id).sort()).toEqual([
      "node-a",
      "node-b",
      "node-c",
    ]);
    expect(report.failed).toEqual([]);

    for (const endpoint of endpoints) {
      expect((await storedOn(endpoint, "multi-001"))?.equals(bytes)).toBe(true);
    }
  });

  it("2. retrieves successfully from replicas", async () => {
    await storePieceOnNodes("multi-002", Buffer.from("replica-read"), endpoints);

    const got = await getPieceFromNodes("multi-002", endpoints);
    expect(got.bytes.toString("utf8")).toBe("replica-read");
    expect(endpoints.map((e) => e.id)).toContain(got.from.id);
  });

  it("3. retrieval succeeds with one node unavailable", async () => {
    await storePieceOnNodes("multi-003", Buffer.from("degraded-read"), endpoints);

    const got = await getPieceFromNodes("multi-003", [deadA, ...endpoints], {
      timeoutMs: 3000,
    });
    expect(got.bytes.toString("utf8")).toBe("degraded-read");
    expect(got.from.id).not.toBe("node-dead-a");
  });

  it("4. all nodes unavailable returns a clear error", async () => {
    await expect(
      getPieceFromNodes("multi-004", [deadA, deadB], { timeoutMs: 3000 }),
    ).rejects.toThrow(/unavailable/);
  });

  it("5. partial store reports failed nodes", async () => {
    const report = await storePieceOnNodes(
      "multi-005",
      Buffer.from("partial-write"),
      [endpoints[0] as StorageNodeEndpoint, deadA],
      { timeoutMs: 3000 },
    );

    expect(report.succeeded.map((e) => e.id)).toEqual(["node-a"]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.endpoint.id).toBe("node-dead-a");
    expect(report.failed[0]?.error).toBeTruthy();

    const got = await getPieceFromNodes("multi-005", endpoints);
    expect(got.bytes.toString("utf8")).toBe("partial-write");
  });

  it("6. retrieved bytes are unchanged", async () => {
    const palette = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    const random = randomBytes(32768);
    for (const [pieceId, bytes] of [
      ["multi-006-palette", palette],
      ["multi-006-random", random],
    ] as Array<[string, Buffer]>) {
      const report = await storePieceOnNodes(pieceId, bytes, endpoints);
      expect(report.failed).toEqual([]);
      const got = await getPieceFromNodes(pieceId, endpoints);
      expect(got.bytes.equals(bytes)).toBe(true);
    }
  });

  it("replication factor limits how many nodes are targeted", async () => {
    const report = await storePieceOnNodes(
      "multi-rf",
      Buffer.from("rf-two"),
      endpoints,
      { replicationFactor: 2 },
    );

    expect(report.succeeded).toHaveLength(2);
    expect(report.failed).toEqual([]);
    expect(
      (await storedOn(endpoints[2] as StorageNodeEndpoint, "multi-rf")),
    ).toBe(null);
  });
});
