import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { createIdentity } from "../../packages/identity/index.js";
import { createRegistry } from "../../packages/registry/index.js";
import { DEFAULT_STORAGE_SCORE } from "../../packages/registry/index.js";
import { hashPieceId } from "../../packages/manifest/index.js";
import { createStorageNode } from "../storage-node/index.js";
import type { StorageNode } from "../storage-node/index.js";
import {
  auditNodeEndpoint,
  auditNodes,
  createAuditScheduler,
  recordAuditReport,
  samplePieceIds,
} from "./audit.js";

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

let storageDir = "";
let baseUrl = "";
let node: StorageNode;
const nodeIdentity = createIdentity();

async function storeContentAddressed(bytes: Buffer): Promise<string> {
  const pieceId = hashPieceId(bytes);
  const res = await fetch(`${baseUrl}/pieces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: pieceId, data: bytes.toString("base64") }),
  });
  expect([200, 201]).toContain(res.status);
  return pieceId;
}

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), "openstore-audit-"));
  node = createStorageNode({ storageDir, identity: nodeIdentity });
  const port = await node.listen(0, "127.0.0.1");
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await node.close();
  await rm(storageDir, { recursive: true, force: true });
});

describe("automated storage audits (OPENSTORE-018)", () => {
  it("1. healthy piece audit succeeds", async () => {
    const ids = [await storeContentAddressed(Buffer.from("audit-healthy-a")), await storeContentAddressed(Buffer.from("audit-healthy-b"))];
    const outcome = await auditNodeEndpoint({ id: "audit-node", baseUrl }, ids);
    expect(outcome.unreachable).toBe(false);
    expect(outcome.checked).toBe(2);
    expect(outcome.healthy).toBe(2);
    expect(outcome.unhealthy).toBe(0);
    expect(outcome.errored).toBe(0);
    expect(outcome.failures).toHaveLength(0);
  });

  it("2. missing piece is detected", async () => {
    const missing = sha256Hex(Buffer.from("audit-never-stored"));
    const outcome = await auditNodeEndpoint({ id: "audit-node", baseUrl }, [missing]);
    expect(outcome.unreachable).toBe(false);
    expect(outcome.checked).toBe(1);
    expect(outcome.healthy).toBe(0);
    expect(outcome.unhealthy).toBe(1);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]?.pieceId).toBe(missing);
  });

  it("3. corrupted piece is detected", async () => {
    const pieceId = await storeContentAddressed(Buffer.from("audit-will-corrupt"));
    await writeFile(join(storageDir, pieceId), Buffer.from("corrupted-bytes-here"));
    const outcome = await auditNodeEndpoint({ id: "audit-node", baseUrl }, [pieceId]);
    expect(outcome.unreachable).toBe(false);
    expect(outcome.healthy).toBe(0);
    expect(outcome.unhealthy).toBe(1);
  });

  it("4. unreachable node is handled safely", async () => {
    // Port that is (almost surely) closed: bind then close a node to get a free port
    const tmpDir = await mkdtemp(join(tmpdir(), "openstore-audit-dead-"));
    const tmpNode = createStorageNode({ storageDir: tmpDir });
    const deadPort = await tmpNode.listen(0, "127.0.0.1");
    await tmpNode.close();
    await rm(tmpDir, { recursive: true, force: true });
    const deadBase = `http://127.0.0.1:${deadPort}`;

    const goodId = await storeContentAddressed(Buffer.from("audit-mixed-reachability"));
    const report = await auditNodes(
      [
        { id: "good-node", baseUrl },
        { id: "dead-node", baseUrl: deadBase },
      ],
      new Map([
        ["good-node", [goodId]],
        ["dead-node", [goodId]],
      ]),
      { timeoutMs: 1000 },
    );
    expect(report.results).toHaveLength(2);
    const good = report.results.find((r) => r.nodeId === "good-node");
    const dead = report.results.find((r) => r.nodeId === "dead-node");
    expect(good?.healthy).toBe(1);
    expect(good?.unreachable).toBe(false);
    expect(dead?.unreachable).toBe(true);
    expect(dead?.healthy).toBe(0);
    expect(dead?.unhealthy).toBe(0);

    // Recording skips the unreachable node without crashing
    const registry = createRegistry();
    const goodIdentity = createIdentity();
    const deadIdentity = createIdentity();
    registry.register("http://127.0.0.1:4201", goodIdentity);
    registry.register("http://127.0.0.1:4202", deadIdentity);
    const remapped: typeof report = {
      ...report,
      results: report.results.map((r) =>
        r.nodeId === "good-node"
          ? { ...r, nodeId: goodIdentity.publicKey.toString("base64") }
          : { ...r, nodeId: deadIdentity.publicKey.toString("base64") },
      ),
    };
    const { recorded, skipped } = recordAuditReport(registry, remapped);
    expect(recorded).toContain(goodIdentity.publicKey.toString("base64"));
    expect(skipped).toContain(deadIdentity.publicKey.toString("base64"));
    // Unreachable node's storage health untouched
    expect(registry.get(deadIdentity.publicKey.toString("base64"))?.reliability.successfulAudits).toBe(0);
    expect(registry.get(deadIdentity.publicKey.toString("base64"))?.reliability.failedAudits).toBe(0);
  });

  it("5. successful audit improves/maintains storage health", async () => {
    const registry = createRegistry();
    const id = createIdentity();
    const nodeId = id.publicKey.toString("base64");
    registry.register("http://127.0.0.1:4203", id);
    expect(registry.get(nodeId)?.reliability.storageScore).toBe(DEFAULT_STORAGE_SCORE);

    const pieceId = await storeContentAddressed(Buffer.from("audit-health-good"));
    const outcome = await auditNodeEndpoint({ id: nodeId, baseUrl }, [pieceId]);
    expect(outcome.healthy).toBe(1);
    const report = await auditNodes([{ id: nodeId, baseUrl }], [pieceId]);
    recordAuditReport(registry, report);
    const rel = registry.get(nodeId)?.reliability;
    expect(rel?.successfulAudits).toBe(1);
    expect(rel?.failedAudits).toBe(0);
    expect(rel?.storageScore).toBeGreaterThanOrEqual(DEFAULT_STORAGE_SCORE);
  });

  it("6. failed audit affects storage health (heartbeat stats untouched)", async () => {
    const registry = createRegistry();
    const id = createIdentity();
    const nodeId = id.publicKey.toString("base64");
    registry.register("http://127.0.0.1:4204", id);
    registry.heartbeat(nodeId, id);
    const hbBefore = registry.get(nodeId)?.reliability;
    const hbSuccess = hbBefore?.successfulHeartbeats;
    const hbScore = hbBefore?.score;

    const missing = sha256Hex(Buffer.from("audit-health-bad"));
    const report = await auditNodes([{ id: nodeId, baseUrl }], [missing]);
    expect(report.results[0]?.unhealthy).toBe(1);
    recordAuditReport(registry, report);
    const rel = registry.get(nodeId)?.reliability;
    expect(rel?.failedAudits).toBe(1);
    expect(rel?.storageScore).toBeLessThan(DEFAULT_STORAGE_SCORE);
    // Heartbeat statistics are separate and undistorted
    expect(rel?.successfulHeartbeats).toBe(hbSuccess);
    expect(rel?.missedHeartbeats).toBe(0);
    expect(rel?.score).toBe(hbScore);
  });

  it("7. same audit is not double-counted", async () => {
    const registry = createRegistry();
    const id = createIdentity();
    const nodeId = id.publicKey.toString("base64");
    registry.register("http://127.0.0.1:4205", id);
    const pieceId = await storeContentAddressed(Buffer.from("audit-dedup"));
    const report = await auditNodes([{ id: nodeId, baseUrl }], [pieceId]);
    recordAuditReport(registry, report);
    const first = registry.get(nodeId)?.reliability;
    recordAuditReport(registry, report);
    const second = registry.get(nodeId)?.reliability;
    expect(second).toEqual(first);
    expect(second?.successfulAudits).toBe(1);

    // Direct registry-level idempotency as well
    registry.recordStorageAudit(nodeId, { auditId: report.auditId, healthy: 5, unhealthy: 5 });
    expect(registry.get(nodeId)?.reliability).toEqual(second);
  });

  it("8. configurable sample size/frequency works", async () => {
    const ids = [
      await storeContentAddressed(Buffer.from("audit-sample-1")),
      await storeContentAddressed(Buffer.from("audit-sample-2")),
      await storeContentAddressed(Buffer.from("audit-sample-3")),
      await storeContentAddressed(Buffer.from("audit-sample-4")),
    ];
    // Deterministic sampling: sorted IDs, first N
    const expected = [...ids].sort().slice(0, 2);
    expect(samplePieceIds(ids, 2)).toEqual(expected);
    const outcome = await auditNodeEndpoint({ id: "audit-node", baseUrl }, ids, { sampleSize: 2 });
    expect(outcome.checked).toBe(2);
    expect(outcome.healthy).toBe(2);
    expect(() => samplePieceIds(ids, 0)).toThrow(/sampleSize/i);
    expect(() => samplePieceIds(ids, -1)).toThrow(/sampleSize/i);

    // Frequency: scheduler runs periodically and records into the registry
    const registry = createRegistry();
    const schedIdentity = createIdentity();
    const schedNodeId = schedIdentity.publicKey.toString("base64");
    registry.register(baseUrl, schedIdentity);
    const seen: string[] = [];
    const scheduler = createAuditScheduler({
      registry,
      resolveExpectedPieces: () => ids.slice(0, 1),
      intervalMs: 30,
      sampleSize: 1,
      onReport: (r) => seen.push(r.auditId),
    });
    expect(scheduler.running).toBe(false);
    const once = await scheduler.runOnce();
    expect(once.results).toHaveLength(1);
    expect(once.results[0]?.healthy).toBe(1);
    scheduler.start();
    expect(scheduler.running).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    scheduler.stop();
    expect(scheduler.running).toBe(false);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    // Each scheduled run used a fresh auditId, so all counted once each
    const rel = registry.get(schedNodeId)?.reliability;
    expect(rel?.successfulAudits).toBeGreaterThanOrEqual(1 + seen.length);
  });

  it("9. no piece contents or keys leak", async () => {
    const secret = Buffer.from("audit-top-secret-plaintext");
    const pieceId = await storeContentAddressed(secret);
    const outcome = await auditNodeEndpoint({ id: "audit-node", baseUrl }, [pieceId]);
    const report = await auditNodes([{ id: "audit-node", baseUrl }], [pieceId]);
    const text = JSON.stringify({ outcome, report });
    expect(text).not.toContain("audit-top-secret-plaintext");
    expect(text).not.toContain(secret.toString("base64"));
    expect(text).not.toContain(nodeIdentity.privateKey.toString("base64"));
    expect(text).not.toContain(nodeIdentity.privateKey.toString("hex"));
    expect(text.toLowerCase()).not.toContain("privatekey");
    expect(text.toLowerCase()).not.toContain("encryptionkey");
    expect(text.toLowerCase()).not.toContain("recoveryphrase");
    // No raw data fields anywhere
    expect(text).not.toContain("\"data\"");
    // Heartbeat-only registry persistence also stays clean
    const dir = await mkdtemp(join(tmpdir(), "openstore-audit-persist-"));
    const file = join(dir, "registry.json");
    const reg = createRegistry({ persistencePath: file });
    const rid = createIdentity();
    reg.register("http://127.0.0.1:4206", rid);
    reg.recordStorageAudit(rid.publicKey.toString("base64"), { auditId: "abc123", healthy: 1, unhealthy: 0 });
    const content = await readFile(file, "utf8");
    expect(content).not.toContain(rid.privateKey.toString("base64"));
    expect(content.toLowerCase()).not.toContain("privatekey");
    await rm(dir, { recursive: true, force: true });
  });
});
