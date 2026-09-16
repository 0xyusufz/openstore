#!/usr/bin/env node
import { readFile } from "fs/promises";
import { createLibp2pStorageNodeRuntime, validateLibp2pStorageNodeRuntimeConfig, type Libp2pStorageNodeRuntimeConfig } from "./libp2p-runtime.js";
import type { P2PPeerDescriptor } from "../../packages/p2p/index.js";

export interface StorageNodeCliOptions {
  configPath?: string;
  config?: Partial<Libp2pStorageNodeRuntimeConfig>;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

function errorMessage(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) { messages.push(current.message); current = current.cause; }
    else { messages.push(typeof current === "string" ? current : "storage node failed"); break; }
  }
  return (messages.filter(Boolean).join(": ") || "storage node failed")
    .replace(/(password|token|secret|private key|recovery phrase|seed)(?:\s*[:=]\s*)?[^\s:;,)]*/gi, "$1 [redacted]");
}

function usage(): string {
  return "Usage: openstore-storage-node --storage-dir <dir> --identity <keystore> --password-env <ENV> [--listen <multiaddr>] [--bootstrap <descriptor.json>] [--capacity-bytes <n>] [--max-piece-bytes <n>] [--refresh-interval-ms <n>] [--coordinator-url <url>] [--coordinator-token-env <ENV>] [--coordinator-token <token>] [--heartbeat-interval-ms <n>]";
}

export async function runStorageNodeCli(argv: string[], options: StorageNodeCliOptions = {}): Promise<number> {
  const out = options.out ?? console.log;
  const err = options.err ?? console.error;
  try {
    const parsed: Record<string, string | undefined> = {};
    const listens: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === "--help" || arg === "-h") { out(usage()); return 0; }
      const key = arg?.replace(/^--/, "");
      if (!key || !["storage-dir", "identity", "identity-path", "keystore", "password-env", "listen", "bootstrap", "config", "capacity-bytes", "max-piece-bytes", "refresh-interval-ms", "coordinator-url", "coordinator-token-env", "coordinator-token", "heartbeat-interval-ms"].includes(key)) throw new Error(`unknown option: ${arg}`);
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (key === "listen") listens.push(value); else parsed[key] = value;
    }
    let config: Record<string, unknown> = { ...(options.config ?? {}) };
    if (parsed.config) config = { ...config, ...(JSON.parse(await readFile(parsed.config, "utf8")) as object) };
    if (parsed["storage-dir"]) config.storageDir = parsed["storage-dir"];
    if (parsed.identity || parsed["identity-path"] || parsed.keystore) config.identityPath = parsed.identity ?? parsed["identity-path"] ?? parsed.keystore;
    if (parsed["password-env"]) {
      const password = process.env[parsed["password-env"]];
      if (!password) throw new Error("password environment variable is empty or unset");
      config.identityPassword = password;
    }
    if (listens.length) config.listenAddrs = listens;
    if (parsed["capacity-bytes"]) config.capacityBytes = Number(parsed["capacity-bytes"]);
    if (parsed["max-piece-bytes"]) config.maxPieceBytes = Number(parsed["max-piece-bytes"]);
    if (parsed["refresh-interval-ms"]) config.discoveryRefreshIntervalMs = Number(parsed["refresh-interval-ms"]);
    if (parsed["coordinator-url"]) config.coordinatorUrl = parsed["coordinator-url"];
    if (parsed["coordinator-token-env"]) {
      const token = process.env[parsed["coordinator-token-env"]];
      if (!token) throw new Error("coordinator token environment variable is empty or unset");
      config.coordinatorToken = token;
    }
    if (parsed["coordinator-token"]) config.coordinatorToken = parsed["coordinator-token"];
    if (parsed["heartbeat-interval-ms"]) config.heartbeatIntervalMs = Number(parsed["heartbeat-interval-ms"]);
    if (parsed.bootstrap) {
      config.bootstrapPeers = JSON.parse(await readFile(parsed.bootstrap, "utf8")) as P2PPeerDescriptor[];
    }
    validateLibp2pStorageNodeRuntimeConfig(config);
    const runtime = await createLibp2pStorageNodeRuntime(config);
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= runtime.stop().catch(() => undefined);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await runtime.start();
    out(JSON.stringify({ event: "started", peerId: runtime.node.peerId, listenAddrs: runtime.node.listenAddrs }));
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
    });
    await stop();
    return 0;
  } catch (error) {
    err(errorMessage(error));
    return 2;
  }
}

if (process.argv[1]?.endsWith("libp2p-cli.ts") || process.argv[1]?.endsWith("libp2p-cli.js")) {
  void runStorageNodeCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
