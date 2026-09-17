import { readFile } from "fs/promises";
import { describe, expect, it } from "vitest";

describe("Milestone 050B operator lifecycle packaging", () => {
  it("provides guarded lifecycle commands without embedding secrets", async () => {
    const script = await readFile("deploy/testnet/testnet.sh", "utf8");
    expect(script).toContain("start)");
    expect(script).toContain("stop)");
    expect(script).toContain("restart)");
    expect(script).toContain("status)");
    expect(script).toContain("logs)");
    expect(script).toContain('reset)');
    expect(script).toContain('= "--yes"');
    expect(script).toContain("compose down -v");
    expect(script).toContain("OPENSTORE_TESTNET_ENV_FILE");
    expect(script).not.toMatch(/OPENSTORE_COORDINATOR_TOKEN\s*=/);
    expect(script).not.toMatch(/NODE_PASSWORD\s*=/);
    expect(script).not.toContain("echo $");
  });

  it("keeps persistent volumes, localhost bindings, and restart-safe bootstrap", async () => {
    const [compose, entrypoint] = await Promise.all([
      readFile("deploy/testnet/docker-compose.yml", "utf8"),
      readFile("deploy/testnet/entrypoint-storage-node.sh", "utf8"),
    ]);
    for (const volume of [
      "coordinator-registry",
      "node-1-identity", "node-1-pieces",
      "node-2-identity", "node-2-pieces",
      "node-3-identity", "node-3-pieces",
    ]) expect(compose).toContain(`${volume}:`);
    expect((compose.match(/127\.0\.0\.1:/g) ?? []).length).toBe(4);
    expect((compose.match(/restart: unless-stopped/g) ?? []).length).toBe(4);
    expect(entrypoint).toContain('if [ ! -e "$OPENSTORE_NODE_IDENTITY" ]');
    expect(entrypoint).toContain("saveIdentity(");
    expect(entrypoint).toContain("--identity \"$OPENSTORE_NODE_IDENTITY\"");
    expect(entrypoint).not.toContain("rm -rf");
  });
});
