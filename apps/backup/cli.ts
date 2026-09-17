#!/usr/bin/env node
import { createBackup, restoreBackup, verifyBackup, type BackupSources } from "../../packages/backup/index.js";

function value(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index < 0 ? undefined : argv[index + 1];
}

function required(argv: string[], flag: string): string {
  const found = value(argv, flag);
  if (!found || found.startsWith("--")) throw new Error(`${flag} requires a value`);
  return found;
}

function usage(): string {
  return [
    "openstore-backup create --destination DIR [component options]",
    "  --client-keystore FILE --client-manifests DIR [--client-operations DIR] [--client-dek FILE]",
    "  --coordinator-registry FILE",
    "  --storage-identity FILE --storage-pieces DIR",
    "openstore-backup verify --backup DIR",
    "openstore-backup restore --backup DIR --destination DIR [--replace]",
  ].join("\n");
}

export async function runBackupCli(argv: string[], io: { out?: (line: string) => void; err?: (line: string) => void } = {}): Promise<number> {
  const out = io.out ?? console.log;
  const err = io.err ?? console.error;
  try {
    const command = argv[0];
    if (!command || command === "--help" || command === "-h") { out(usage()); return 0; }
    if (command === "verify") {
      const report = await verifyBackup(required(argv, "--backup"));
      out(JSON.stringify(report));
      return report.valid ? 0 : 1;
    }
    if (command === "restore") {
      const inventory = await restoreBackup({
        backupDir: required(argv, "--backup"),
        destination: required(argv, "--destination"),
        replace: argv.includes("--replace"),
      });
      out(JSON.stringify({ restored: true, components: inventory.components }));
      return 0;
    }
    if (command !== "create") throw new Error(`unknown command: ${command}`);
    const sources: BackupSources = {};
    const clientKeystore = value(argv, "--client-keystore");
    const clientManifests = value(argv, "--client-manifests");
    if ((clientKeystore && !clientManifests) || (!clientKeystore && clientManifests)) {
      throw new Error("--client-keystore and --client-manifests must be supplied together");
    }
    if (clientKeystore && clientManifests) {
      sources.client = {
        keystorePath: clientKeystore,
        manifestDir: clientManifests,
        ...(value(argv, "--client-operations") ? { operationDir: value(argv, "--client-operations") } : {}),
        ...(value(argv, "--client-dek") ? { dekPath: value(argv, "--client-dek") } : {}),
      };
    }
    const registry = value(argv, "--coordinator-registry");
    if (registry) sources.coordinator = { registryPath: registry };
    const identity = value(argv, "--storage-identity");
    const pieces = value(argv, "--storage-pieces");
    if ((identity && !pieces) || (!identity && pieces)) throw new Error("--storage-identity and --storage-pieces must be supplied together");
    if (identity && pieces) sources.storageNode = { identityPath: identity, storageDir: pieces };
    const inventory = await createBackup({ destination: required(argv, "--destination"), sources });
    out(JSON.stringify({ created: true, components: inventory.components, entries: inventory.entries.length }));
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : "backup operation failed");
    return 1;
  }
}

if (process.argv[1]?.endsWith("backup/cli.ts") || process.argv[1]?.endsWith("backup/cli.js")) {
  void runBackupCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
