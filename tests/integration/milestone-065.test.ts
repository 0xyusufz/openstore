import { execFile, execFileSync } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { createServer } from "net";
import { join } from "path";
import { promisify } from "util";
import { describe, expect, it } from "vitest";
import { createCoordinatorAdapter } from "../../apps/client/coordinator.js";
import { downloadBuffer } from "../../apps/client/download.js";
import { uploadBuffer } from "../../apps/client/upload.js";
import { MixedStorageTransport } from "../../apps/client/http-transport.js";
import type { StorageNodeEndpoint } from "../../apps/client/index.js";
import { createManifestStore } from "../../packages/manifest/store.js";
import { createRegistryClient } from "../../packages/registry/coordinator.js";

const run = promisify(execFile);
const dockerAvailable = (() => {
  try { execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const suite = dockerAvailable && process.env.OPENSTORE_RUN_DOCKER_TESTNET === "1" ? describe : describe.skip;

// Milestone 065: Coordinator Persistence Stress.
// Coordinator is abruptly SIGKILLed and restarted while storage nodes stay
// available. Authority (node identities, endpoint set) must never silently
// change; persistence stays bounded; corrupt state fails closed (not-ready).
suite("Milestone 065 coordinator persistence stress integration", () => {
  it("kill/restart cycles preserve authority, stay bounded, and fail closed on corruption", async () => {
    const root = await mkdtemp(join(process.cwd(), ".milestone-065-"));
    const project = `openstore-065-${process.pid}-${Date.now()}`;
    const envPath = join(root, ".env");
    const overridePath = join(root, "override.yml");
    const [coordinatorPort, n1Port, n2Port, n3Port] = await reservePorts(4);
    const token = `065-${process.pid}-${Date.now()}`;
    await writeFile(envPath, [
      `OPENSTORE_COORDINATOR_TOKEN=${token}`,
      "OPENSTORE_NODE_1_PASSWORD=local-node-1-password", "OPENSTORE_NODE_2_PASSWORD=local-node-2-password", "OPENSTORE_NODE_3_PASSWORD=local-node-3-password",
      `OPENSTORE_COORDINATOR_HOST_PORT=${coordinatorPort}`, `OPENSTORE_NODE_1_HOST_PORT=${n1Port}`,
      `OPENSTORE_NODE_2_HOST_PORT=${n2Port}`, `OPENSTORE_NODE_3_HOST_PORT=${n3Port}`, "",
    ].join("\n"), { mode: 0o600 });
    const configFiles = await Promise.all(["node-1", "node-2", "node-3"].map(async (s) => {
      const p = join(root, `${s}.json`);
      await writeFile(p, JSON.stringify({ lifecyclePath: "/var/lib/openstore/pieces/.provider-lifecycle.json" }));
      return p;
    }));
    await writeFile(overridePath, [
      "services:",
      ...(["node-1", "node-2", "node-3"] as const).flatMap((svc, idx) => [
        `  ${svc}:`, "    environment:", "      OPENSTORE_NODE_CONFIG: /etc/openstore/node-config.json",
        "      OPENSTORE_NODE_ALLOCATION_PATH: /var/lib/openstore/pieces/.capacity-allocation.json",
        "      OPENSTORE_NODE_CAPACITY_BYTES: \"67108864\"", "    mem_limit: 768m",
        "    volumes:", `      - "${configFiles[idx]}:/etc/openstore/node-config.json:ro"`,
      ]), "",
    ].join("\n"));
    const compose = (...args: string[]) => run("docker", ["compose", "--project-name", project, "--env-file", envPath, "-f", "deploy/testnet/docker-compose.yml", "-f", overridePath, ...args], { cwd: process.cwd(), maxBuffer: 8 * 1024 * 1024 });
    const baseUrl = `http://127.0.0.1:${coordinatorPort}`;
    const registry = createRegistryClient({ baseUrl, token });
    const adapter = createCoordinatorAdapter({ baseUrl, token });
    const manifests = createManifestStore({ dir: join(root, "manifests") });
    const transport = new MixedStorageTransport();
    const ports = new Map([["node-1", n1Port], ["node-2", n2Port], ["node-3", n3Port]] as const);
    const host = (ep: StorageNodeEndpoint): StorageNodeEndpoint => {
      const svc = serviceFor(ep);
      serviceById.set(ep.id, svc);
      return { ...ep, multiaddr: ep.multiaddr?.replace(/\/dns4\/[^/]+\/tcp\/\d+/, `/ip4/127.0.0.1/tcp/${ports.get(svc)}`) };
    };
    const hostAware = {
      refresh: async () => (await adapter.refresh()).map(host),
      getEndpoints: () => adapter.getEndpoints().map(host),
      getKnownEndpoints: () => adapter.getKnownEndpoints().map(host),
      get discovery() { return adapter.discovery; },
    } as unknown as ReturnType<typeof createCoordinatorAdapter>;
    const exec = (svc: string, ...cmd: string[]) => compose("exec", "-T", svc, ...cmd);
    const coordLs = async () => (await exec("coordinator", "sh", "-c", "ls -a /var/lib/openstore/coordinator")).stdout;
    const coordReady = async (): Promise<number> => {
      try {
        const res = await fetch(`${baseUrl}/v1/ready`);
        return res.status;
      } catch {
        return 0;
      }
    };

    try {
      await compose("up", "-d", "--build");
      await waitFor(async () => (await registry.status()).status === "ok");
      let endpoints = (await waitForEndpoints(adapter)).map(host);
      expect(endpoints.length).toBe(3);

      const plaintext = Buffer.alloc(1024 * 1024 + 123);
      const marker = Buffer.from("065-persistence-plaintext");
      for (let o = 0; o < plaintext.length; o += marker.length) marker.copy(plaintext, o);
      const uploaded = await uploadBuffer(plaintext, "065-base.bin", endpoints, {
        chunkSize: 4 * 1024 * 1024, replicationFactor: 2, manifestStore: manifests,
      });
      const baselineIds = endpoints.map((e) => e.id).sort();
      const baselineNodes = (await registryNodes(registry)).map((n) => n.nodeId).sort();

      // 1-2. Repeated abrupt coordinator kills preserve the latest valid state.
      for (let cycle = 0; cycle < 3; cycle++) {
        await compose("kill", "coordinator");
        await waitFor(async () => (await coordReady()) === 0, 30_000).catch(() => undefined);
        await compose("start", "coordinator");
        await waitFor(async () => (await registry.status()).status === "ok");
        // Convergence gate: the first post-restart refresh can report 3
        // available nodes from stale pre-kill lastSeen values (heartbeat
        // timeout is 3000ms), before prune() expires the node(s) whose
        // heartbeats have not re-arrived yet. Heartbeats re-mark nodes
        // available unconditionally, so poll until the authoritative
        // registry converges back to exactly the 3 baseline identities.
        await waitFor(async () => {
          try {
            const eps = await hostAware.refresh();
            const ids = eps.map((e) => e.id).sort();
            return ids.length === 3 && ids.every((id, i) => id === baselineIds[i]);
          } catch {
            return false;
          }
        });
        // Authority never silently changes: same node identities, no duplicates.
        const ids = (await registryNodes(registry)).map((n) => n.nodeId).sort();
        expect(ids).toEqual(baselineNodes);
        expect(new Set(ids).size).toBe(3);
        const eps = await hostAware.refresh();
        expect(eps.map((e) => e.id).sort()).toEqual(baselineIds);
      }
      // 13. Bounded: only the committed registry file, no temp artifacts.
      expect((await coordLs()).split("\n").map((s) => s.trim()).filter(Boolean).sort()).toEqual([".", "..", "registry.json"]);

      // Placement stays authoritative after heal: new upload + download work.
      // Same convergence family as above: require a fresh discovery snapshot
      // over exactly the baseline identities before placing, so the upload
      // never races a prune dip right after the kill loop.
      endpoints = (await waitForEndpoints(adapter)).map(host);
      await waitFor(async () => {
        try {
          const eps = await hostAware.refresh();
          const ids = eps.map((e) => e.id).sort();
          return (
            ids.length === 3 &&
            ids.every((id, i) => id === baselineIds[i]) &&
            hostAware.discovery.freshness === "fresh"
          );
        } catch {
          return false;
        }
      });
      const healed = await uploadBuffer(Buffer.from("065-healed"), "065-healed.bin", [], {
        coordinator: hostAware, manifestStore: manifests, replicationFactor: 2,
      });
      expect(healed.manifest.chunks[0]!.nodeIds).toHaveLength(2);
      expect(await downloadBuffer(uploaded.manifest, uploaded.encryptionKey, endpoints, { transport })).toEqual(plaintext);

      // 3-4. Corrupt persistence fails closed (not-ready, no endpoints invented).
      // `exec` needs a running container, so plant the corrupt file with
      // `docker cp` (works on stopped containers, same pattern as 061b).
      await compose("stop", "coordinator");
      const corruptLocal = join(root, "corrupt-registry.json");
      await writeFile(corruptLocal, "{corrupt", "utf8");
      const coordContainer = (await compose("ps", "-aq", "coordinator")).stdout.trim();
      if (!coordContainer) throw new Error("missing coordinator container");
      await run("docker", ["cp", corruptLocal, `${coordContainer}:/var/lib/openstore/coordinator/registry.json`]);
      await compose("start", "coordinator");
      await waitFor(async () => (await coordReady()) === 503, 60_000);
      // Nodes re-register against the empty (fail-closed) registry; the
      // coordinator reports degraded and never serves the corrupt state.
      await waitFor(async () => {
        try {
          const status = await registry.status();
          return status.persistence?.degraded === true || (status as { status?: string }).status === "degraded";
        } catch {
          return false;
        }
      }, 60_000);
      // Recover: remove the corrupt file, restart, authority re-establishes
      // from fresh node heartbeats (no phantom state).
      await exec("coordinator", "sh", "-c", "rm -f /var/lib/openstore/coordinator/registry.json");
      await compose("restart", "coordinator");
      await waitFor(async () => (await registry.status()).status === "ok");
      await waitFor(async () => (await hostAware.refresh()).length === 3);
      expect((await coordReady())).toBe(200);
      const recoveredIds = (await registryNodes(registry)).map((n) => n.nodeId).sort();
      expect(recoveredIds).toEqual(baselineIds);
      expect((await coordLs()).split("\n").map((s) => s.trim()).filter(Boolean).sort()).toEqual([".", "..", "registry.json"]);

      // Final: storage nodes remained available throughout; data intact.
      endpoints = (await waitForEndpoints(adapter)).map(host);
      expect(await downloadBuffer(uploaded.manifest, uploaded.encryptionKey, endpoints, { transport })).toEqual(plaintext);
      expect(await downloadBuffer(healed.manifest, healed.encryptionKey, endpoints, { transport })).toEqual(Buffer.from("065-healed"));
      const logs = await compose("logs", "--no-log-prefix");
      expect(logs.stdout).not.toContain(marker.toString());
      expect(logs.stderr).not.toContain(marker.toString());
      expect(logs.stdout).not.toContain(token);
    } finally {
      await compose("down", "-v").catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 420_000);
});

const serviceById = new Map<string, "node-1" | "node-2" | "node-3">();
function serviceFor(ep: StorageNodeEndpoint): "node-1" | "node-2" | "node-3" {
  const known = serviceById.get(ep.id);
  if (known) return known;
  const a = ep.multiaddr ?? "";
  if (a.includes("4101") || a.includes("node-1")) return "node-1";
  if (a.includes("4102") || a.includes("node-2")) return "node-2";
  return "node-3";
}
async function registryNodes(registry: { nodes(): Promise<any[]> }): Promise<any[]> {
  let last: unknown;
  for (let i = 0; i < 8; i++) {
    try {
      return await registry.nodes();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw last;
}
async function waitForEndpoints(adapter: ReturnType<typeof createCoordinatorAdapter>): Promise<StorageNodeEndpoint[]> {
  let eps: StorageNodeEndpoint[] = [];
  await waitFor(async () => { eps = await adapter.refresh(); return eps.length === 3; });
  return eps;
}
async function waitFor(check: () => Promise<boolean>, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await new Promise((r) => setTimeout(r, 300)); }
  throw new Error("065 readiness timeout");
}
async function reservePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i++) { const s = createServer(); await new Promise<void>((res, rej) => s.once("error", rej).listen(0, "127.0.0.1", () => res())); const a = s.address(); if (!a || typeof a === "string") throw new Error("port"); ports.push((a as import("net").AddressInfo).port); await new Promise<void>((res) => s.close(() => res())); }
  return ports;
}
