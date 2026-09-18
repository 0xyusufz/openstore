import { execFile, execFileSync } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { describe, expect, it } from "vitest";
import { createRegistryClient } from "../../packages/registry/coordinator.js";

const run = promisify(execFile);
const dockerAvailable = (() => {
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const suite = dockerAvailable && process.env.OPENSTORE_RUN_DOCKER_TESTNET === "1" ? describe : describe.skip;

suite("Milestone 057A real multi-node testnet foundation", () => {
  it("starts three independent nodes, observes readiness, isolates storage, and tears down cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "openstore-057a-"));
    const project = `openstore-057a-${process.pid}-${Date.now()}`;
    const envPath = join(root, ".env.testnet");
    const ports = await reservePorts(4);
    const [coordinatorPort, node1Port, node2Port, node3Port] = ports;
    const token = `057a-${process.pid}-${Date.now()}`;
    await writeFile(envPath, [
      `OPENSTORE_COORDINATOR_TOKEN=${token}`,
      "OPENSTORE_NODE_1_PASSWORD=local-node-1-password",
      "OPENSTORE_NODE_2_PASSWORD=local-node-2-password",
      "OPENSTORE_NODE_3_PASSWORD=local-node-3-password",
      `OPENSTORE_COORDINATOR_HOST_PORT=${coordinatorPort}`,
      `OPENSTORE_NODE_1_HOST_PORT=${node1Port}`,
      `OPENSTORE_NODE_2_HOST_PORT=${node2Port}`,
      `OPENSTORE_NODE_3_HOST_PORT=${node3Port}`,
      "",
    ].join("\n"), { mode: 0o600 });

    const compose = (...args: string[]) => run("docker", [
      "compose", "--project-name", project, "--env-file", envPath,
      "-f", "deploy/testnet/docker-compose.yml", ...args,
    ], { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 });
    const coordinatorUrl = `http://127.0.0.1:${coordinatorPort}`;
    const registry = createRegistryClient({ baseUrl: coordinatorUrl, token });

    try {
      await compose("up", "-d", "--build");
      await waitFor(async () => (await registry.status()).status === "ok");
      await waitFor(async () => (await registry.nodes()).filter((node) => node.available).length === 3);

      const nodes = await registry.nodes();
      expect(nodes).toHaveLength(3);
      expect(new Set(nodes.map((node) => node.nodeId)).size).toBe(3);
      expect(new Set(nodes.map((node) => node.baseUrl)).size).toBe(3);
      expect(new Set(nodes.map((node) => node.multiaddr)).size).toBe(3);

      const inspect = await compose("config", "--volumes");
      for (const volume of ["node-1-identity", "node-1-pieces", "node-2-identity", "node-2-pieces", "node-3-identity", "node-3-pieces"]) {
        expect(inspect.stdout).toContain(volume);
      }
      expect(inspect.stdout).toContain("coordinator-registry");

      const statuses = await compose("ps", "--format", "{{.Service}}={{.State}}");
      for (const service of ["coordinator", "node-1", "node-2", "node-3"]) {
        expect(statuses.stdout).toMatch(new RegExp(`^${service}=running$`, "m"));
      }

      await compose("stop", "node-1");
      await waitFor(async () => !(await registry.nodes()).some((node) => node.available && node.multiaddr?.includes("/node-1/")));
      const remaining = await compose("ps", "--format", "{{.Service}}={{.State}}");
      expect(remaining.stdout).toMatch(/^node-2=running$/m);
      expect(remaining.stdout).toMatch(/^node-3=running$/m);

      await compose("down", "-v");
      const afterTeardown = await compose("ps", "--all", "--format", "{{.Service}}");
      expect(afterTeardown.stdout.trim()).toBe("");
    } finally {
      await compose("down", "-v").catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 240_000);
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // Services may still be starting; readiness checks retry.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("057A testnet readiness timeout");
}

async function reservePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to reserve test port");
    ports.push(address.port);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return ports;
}
