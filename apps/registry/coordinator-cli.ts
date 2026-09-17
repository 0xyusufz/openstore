#!/usr/bin/env node
import { createRegistry } from "../../packages/registry/index.js";
import { createRegistryCoordinator } from "../../packages/registry/coordinator.js";

export async function runRegistryCoordinatorCli(argv: string[], io: { out?: (line: string) => void; err?: (line: string) => void } = {}): Promise<number> {
  const out = io.out ?? console.log; const err = io.err ?? console.error;
  try {
    let port = 4190; let host = "127.0.0.1"; let persistencePath: string | undefined; let token = process.env.OPENSTORE_COORDINATOR_TOKEN;
    let timeout: number | undefined;
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === "--help" || arg === "-h") { out("Usage: openstore-registry --port <n> [--host <address>] [--persistence <file>] [--heartbeat-timeout-ms <n>] [--token-env <ENV>"); return 0; }
      const value = argv[++i]; if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--port") port = Number(value);
      else if (arg === "--host") host = value;
      else if (arg === "--persistence") persistencePath = value;
      else if (arg === "--heartbeat-timeout-ms") timeout = Number(value);
      else if (arg === "--token-env") { token = process.env[value]; if (!token) throw new Error("coordinator token environment variable is empty or unset"); }
      else throw new Error(`unknown option: ${arg}`);
    }
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("port must be 0..65535");
    const registry = createRegistry({
      persistencePath,
      heartbeatTimeoutMs: timeout,
      logger: { warn: (message, details) => err(JSON.stringify({ event: message, ...details })) },
    });
    const coordinator = createRegistryCoordinator({ registry, token });
    const actual = await coordinator.listen(port, host);
    out(JSON.stringify({ event: "started", protocol: 1, url: `${coordinator.address}`, authenticated: Boolean(token), persistence: registry.persistenceStatus() }));
    await new Promise<void>((resolve) => { const stop = () => { void coordinator.close().finally(resolve); }; process.once("SIGINT", stop); process.once("SIGTERM", stop); });
    return actual >= 0 ? 0 : 2;
  } catch (error) { err(error instanceof Error ? error.message : "registry coordinator failed"); return 2; }
}

if (process.argv[1]?.endsWith("coordinator-cli.ts") || process.argv[1]?.endsWith("coordinator-cli.js")) {
  void runRegistryCoordinatorCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
