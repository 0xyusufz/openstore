import { execFile, execFileSync } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { createServer } from "net";
import { join } from "path";
import { promisify } from "util";
import { describe, expect, it } from "vitest";
import { createRegistryClient } from "../../packages/registry/coordinator.js";
import { createCoordinatorAdapter } from "../../apps/client/coordinator.js";

const run = promisify(execFile);
const dockerAvailable = (() => {
  try { execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const suite = dockerAvailable && process.env.OPENSTORE_RUN_DOCKER_TESTNET === "1" ? describe : describe.skip;

// Milestone 066: Docker security smoke test across the real container
// network boundary. The coordinator requires its bearer token for every
// route except readiness; wrong-length and wrong-value tokens fail closed
// with identical 401s; no token or key material appears in responses/logs.
suite("Milestone 066 coordinator auth boundary over Docker network", () => {
  it("enforces bearer auth on all non-readiness routes from outside the container", async () => {
    const root = await mkdtemp(join(process.cwd(), ".milestone-066-"));
    const project = `openstore-066-${process.pid}-${Date.now()}`;
    const envPath = join(root, ".env");
    const [coordinatorPort] = await reservePorts(1);
    const token = `066-${process.pid}-${Date.now()}-secret`;
    await writeFile(envPath, [
      `OPENSTORE_COORDINATOR_TOKEN=${token}`,
      "OPENSTORE_NODE_1_PASSWORD=local-node-1-password",
      "OPENSTORE_NODE_2_PASSWORD=local-node-2-password",
      "OPENSTORE_NODE_3_PASSWORD=local-node-3-password",
      `OPENSTORE_COORDINATOR_HOST_PORT=${coordinatorPort}`,
      "",
    ].join("\n"), { mode: 0o600 });
    const compose = (...args: string[]) => run("docker", ["compose", "--project-name", project, "--env-file", envPath,
      "-f", "deploy/testnet/docker-compose.yml", ...args], { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 });
    const baseUrl = `http://127.0.0.1:${coordinatorPort}`;
    try {
      await compose("up", "-d", "--build", "coordinator");
      await waitFor(async () => {
        try {
          return (await createRegistryClient({ baseUrl, token }).status()).status === "ok";
        } catch {
          return false;
        }
      }, 90_000);
      // Readiness stays public for orchestrators.
      expect((await fetch(`${baseUrl}/v1/ready`)).status).toBe(200);
      // Every other route fails closed without credentials.
      for (const path of ["/v1/metrics", "/v1/nodes", "/v1/status", "/v1/events", "/v1/recovery/inspect"]) {
        const res = await fetch(`${baseUrl}${path}`);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized" });
      }
      // Wrong-length and wrong-value tokens are indistinguishable from missing.
      for (const bad of ["short", `${token}-wrong`, "Basic dG9rZW4="]) {
        const res = await fetch(`${baseUrl}/v1/nodes`, { headers: { authorization: `Bearer ${bad}`.replace("Bearer Basic", "Basic") } });
        expect(res.status).toBe(401);
      }
      // Correct token restores access; adapter discovery works end to end.
      const authed = { headers: { authorization: `Bearer ${token}` } };
      expect((await fetch(`${baseUrl}/v1/metrics`, authed)).status).toBe(200);
      const adapter = createCoordinatorAdapter({ baseUrl, token });
      await expect(adapter.refresh()).resolves.toEqual([]);
      const logs = await compose("logs", "--no-log-prefix", "coordinator");
      expect(logs.stdout).not.toContain(token);
      expect(logs.stderr).not.toContain(token);
    } finally {
      await compose("down", "-v").catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);
});

async function waitFor(check: () => Promise<boolean>, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { try { if (await check()) return; } catch {} await new Promise((r) => setTimeout(r, 300)); }
  throw new Error("066 readiness timeout");
}
async function reservePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  for (let i = 0; i < count; i++) { const s = createServer(); await new Promise<void>((res, rej) => s.once("error", rej).listen(0, "127.0.0.1", () => res())); const a = s.address(); if (!a || typeof a === "string") throw new Error("port"); ports.push((a as import("net").AddressInfo).port); await new Promise<void>((res) => s.close(() => res())); }
  return ports;
}
