import { readFile } from "fs/promises";
import { describe, expect, it } from "vitest";

const composePath = "deploy/testnet/docker-compose.yml";
const dockerfilePath = "deploy/testnet/Dockerfile";
const envExamplePath = "deploy/testnet/.env.example";

describe("Milestone 050A Docker packaging", () => {
  it("defines the isolated coordinator and three-node topology with independent volumes", async () => {
    const compose = await readFile(composePath, "utf8");
    expect(compose).toMatch(/coordinator:/);
    for (const node of ["node-1", "node-2", "node-3"]) {
      expect(compose).toMatch(new RegExp(`\\n  ${node}:`));
      expect(compose).toContain(`OPENSTORE_NODE_LISTEN_ADDR: /dns4/${node}/tcp/`);
      expect(compose).toContain(`${node}-identity:/var/lib/openstore/identity`);
      expect(compose).toContain(`${node}-pieces:/var/lib/openstore/pieces`);
    }
    expect(compose.match(/127\.0\.0\.1:\$\{OPENSTORE_NODE_[1-3]_HOST_PORT:-410[1-3]\}:410[1-3]/g)).toHaveLength(3);
    expect(compose).toContain("openstore-net:");
    expect(compose).toContain("coordinator-registry:/var/lib/openstore/coordinator");
    expect(compose).toMatch(/OPENSTORE_COORDINATOR_TOKEN: "\$\{OPENSTORE_COORDINATOR_TOKEN:\?required\}"/);
    expect(compose.match(/no-new-privileges:true/g)).toHaveLength(4);
    expect(compose.match(/cap_drop: \[ALL\]/g)).toHaveLength(4);
    expect(compose.match(/mem_limit:/g)).toHaveLength(4);
    expect(compose.match(/pids_limit:/g)).toHaveLength(4);
    expect(compose.match(/max-size: 10m/g)).toHaveLength(4);
  });

  it("keeps secrets out of the image and uses encrypted identity bootstrap", async () => {
    const [dockerfile, coordinatorEntrypoint, nodeEntrypoint, envExample] = await Promise.all([
      readFile(dockerfilePath, "utf8"),
      readFile("deploy/testnet/entrypoint-coordinator.sh", "utf8"),
      readFile("deploy/testnet/entrypoint-storage-node.sh", "utf8"),
      readFile(envExamplePath, "utf8"),
    ]);
    expect(dockerfile).not.toMatch(/COPY .*\.env/);
    expect(dockerfile).not.toMatch(/(password|token|private.?key)\s*=/i);
    expect(coordinatorEntrypoint).toContain("--token-env OPENSTORE_COORDINATOR_TOKEN");
    expect(nodeEntrypoint).toContain("createIdentity()");
    expect(nodeEntrypoint).toContain("saveIdentity(");
    expect(nodeEntrypoint).toContain("OPENSTORE_NODE_PASSWORD");
    expect(dockerfile).toContain("useradd --system");
    expect(dockerfile).toContain("npm prune --omit=dev");
    expect(nodeEntrypoint).toContain("gosu openstore");
    expect(coordinatorEntrypoint).toContain("gosu openstore");
    expect(nodeEntrypoint).not.toContain("--coordinator-token ");
    expect(envExample).toContain("replace-with");
    expect(envExample).not.toMatch(/(BEGIN .*PRIVATE KEY|sk_live|ghp_|password123|token123)/i);
  });
});
