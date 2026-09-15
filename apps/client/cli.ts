#!/usr/bin/env node
/**
 * OpenStore CLI Foundation (OPENSTORE-022)
 *
 * Minimal typed CLI over the existing client library. Node.js built-ins
 * only — no CLI framework.
 *
 * Commands:
 *   openstore identity create [--keystore <path>] [--password <pw>]
 *   openstore files list
 *   openstore files get <fileId>
 *   openstore files delete <fileId> --yes [--node <baseUrl> ...]
 *
 * Global flags: --keystore <path>, --store <dir>, --password <pw>,
 * --password-env <VAR> (defaults to OPENSTORE_PASSWORD).
 *
 * Safety: only safe metadata is ever printed. The sole exception is
 * `identity create`, which displays the fresh recovery phrase exactly
 * once so the user can back it up (it is never written to disk);
 * private keys and passwords are never printed anywhere.
 *
 * Exit codes: 0 success, 1 operational failure, 2 usage error.
 */

import { fileURLToPath } from "url";
import { join } from "path";
import { createIdentity } from "../../packages/identity/index.js";
import { saveIdentity } from "../../packages/identity/keystore.js";
import { createManifestStore } from "../../packages/manifest/store.js";
import { isValidManifestFileId } from "../../packages/manifest/store.js";
import type { ManifestStore } from "../../packages/manifest/store.js";
import { createFileCatalog } from "./catalog.js";
import { deleteFile } from "./delete.js";
import type { DeleteFileReport } from "./delete.js";
import type { FileManifest } from "../../packages/manifest/index.js";
import type { StorageNodeEndpoint } from "./index.js";

export const CLI_VERSION = "0.1.0";
export const CLI_NAME = "openstore";

/** Exit codes. */
export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/**
 * Injectable dependencies (paths, output, password, deletion flow).
 * Tests inject temp dirs and capture output; production uses cwd/env.
 */
export interface CliDeps {
  out?: (line: string) => void;
  err?: (line: string) => void;
  cwd?: string;
  env?: Record<string, string | undefined>;
  keystorePath?: string;
  manifestDir?: string;
  /** Explicit password (highest precedence; tests use this). */
  password?: string;
  passwordEnvVar?: string;
  /** Override for the deletion flow (defaults to the real deleteFile). */
  deleteFileFn?: (
    manifest: FileManifest,
    endpoints: StorageNodeEndpoint[],
    options: { manifestStore?: ManifestStore },
  ) => Promise<DeleteFileReport>;
}

interface ParsedArgs {
  positionals: string[];
  keystoreFlag?: string;
  storeFlag?: string;
  passwordFlag?: string;
  passwordEnvFlag?: string;
  yes: boolean;
  nodes: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const parsed: ParsedArgs = { positionals, yes: false, nodes: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === "--yes" || arg === "-y") {
      parsed.yes = true;
    } else if (arg === "--keystore" || arg === "--store" || arg === "--password" || arg === "--password-env" || arg === "--node") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${arg} requires a value`);
      }
      i += 1;
      if (arg === "--keystore") parsed.keystoreFlag = value;
      else if (arg === "--store") parsed.storeFlag = value;
      else if (arg === "--password") parsed.passwordFlag = value;
      else if (arg === "--password-env") parsed.passwordEnvFlag = value;
      else parsed.nodes.push(value);
    } else if (arg.startsWith("--")) {
      throw new UsageError(`unknown flag: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }
  return parsed;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function usage(): string {
  return [
    `${CLI_NAME} — OpenStore client`,
    "",
    "Usage:",
    `  ${CLI_NAME} [global flags] identity create`,
    `  ${CLI_NAME} [global flags] files list`,
    `  ${CLI_NAME} [global flags] files get <fileId>`,
    `  ${CLI_NAME} [global flags] files delete <fileId> --yes [--node <baseUrl> ...]`,
    "",
    "Global flags:",
    "  --keystore <path>       identity keystore file (default ./openstore-identity.json)",
    "  --store <dir>           manifest store directory (default ./openstore-manifests)",
    "  --password <pw>         keystore password (prefer --password-env)",
    "  --password-env <VAR>    env var holding the password (default OPENSTORE_PASSWORD)",
    "  --node <baseUrl>        replica node (repeatable; for files delete)",
    "  --yes, -y               confirm destructive operations",
  ].join("\n");
}

/**
 * Run the CLI. Returns a process exit code (never throws for CLI errors).
 */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const fail = (message: string): number => {
    err(`Error: ${message}`);
    return EXIT_FAILURE;
  };

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    err(`Error: ${(e as Error).message}`);
    err(usage());
    return EXIT_USAGE;
  }

  const [resource, action, fileId, ...extra] = parsed.positionals;
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const keystorePath = parsed.keystoreFlag ?? deps.keystorePath ?? join(cwd, "openstore-identity.json");
  const manifestDir = parsed.storeFlag ?? deps.manifestDir ?? join(cwd, "openstore-manifests");

  try {
    if (resource === undefined || resource === "help" || resource === "--help" || resource === "-h") {
      out(usage());
      return EXIT_OK;
    }
    if (resource === "version" || resource === "--version" || resource === "-v") {
      out(`${CLI_NAME} ${CLI_VERSION}`);
      return EXIT_OK;
    }

    if (resource === "identity" && action === "create" && extra.length === 0) {
      const password =
        deps.password ?? parsed.passwordFlag ?? env[parsed.passwordEnvFlag ?? deps.passwordEnvVar ?? "OPENSTORE_PASSWORD"];
      if (!password) {
        err("Error: a keystore password is required (use --password or set OPENSTORE_PASSWORD).");
        return EXIT_USAGE;
      }
      const identity = createIdentity();
      await saveIdentity(identity, password, keystorePath);
      out("Identity created.");
      out(`Public key: ${identity.publicKey.toString("base64")}`);
      out(`Keystore: ${keystorePath}`);
      out("");
      out("Recovery phrase (shown once — write it down now):");
      out(identity.recoveryPhrase.join(" "));
      out("");
      out("WARNING: Securely back up the recovery phrase above. It is never stored");
      out("on disk and cannot be recovered if lost. Never share it with anyone.");
      return EXIT_OK;
    }

    if (resource === "files" && action === "list" && extra.length === 0 && fileId === undefined) {
      const catalog = createFileCatalog(createManifestStore({ dir: manifestDir }));
      const entries = await catalog.listEntries();
      if (entries.length === 0) {
        out("No files.");
        return EXIT_OK;
      }
      for (const entry of entries) {
        const created = entry.createdAt !== undefined ? ` created ${new Date(entry.createdAt).toISOString()}` : "";
        out(`${entry.fileId}  ${entry.filename}  ${entry.size} bytes  ${entry.totalChunks} chunk(s)${created}`);
      }
      return EXIT_OK;
    }

    if (resource === "files" && action === "get" && typeof fileId === "string" && extra.length === 0) {
      if (!isValidManifestFileId(fileId)) {
        err(`Error: invalid fileId "${fileId}".`);
        return EXIT_USAGE;
      }
      const catalog = createFileCatalog(createManifestStore({ dir: manifestDir }));
      let entry;
      try {
        entry = await catalog.getEntry(fileId);
      } catch (e) {
        return fail(`stored manifest for "${fileId}" is malformed: ${(e as Error).message}`);
      }
      if (!entry) {
        return fail(`no file with ID "${fileId}".`);
      }
      out(`fileId: ${entry.fileId}`);
      out(`filename: ${entry.filename}`);
      out(`size: ${entry.size} bytes`);
      out(`chunks: ${entry.totalChunks}`);
      out(`chunkSize: ${entry.chunkSize}`);
      if (entry.createdAt !== undefined) {
        out(`createdAt: ${new Date(entry.createdAt).toISOString()}`);
      }
      return EXIT_OK;
    }

    if (resource === "files" && action === "delete" && typeof fileId === "string" && extra.length === 0) {
      if (!isValidManifestFileId(fileId)) {
        err(`Error: invalid fileId "${fileId}".`);
        return EXIT_USAGE;
      }
      if (!parsed.yes) {
        err(`Refusing to delete "${fileId}" without confirmation. Re-run with --yes to confirm.`);
        return EXIT_FAILURE;
      }
      if (parsed.nodes.length === 0) {
        err("Error: files delete requires at least one replica node (--node <baseUrl>).");
        return EXIT_USAGE;
      }
      const store = createManifestStore({ dir: manifestDir });
      let manifest;
      try {
        manifest = await store.load(fileId);
      } catch (e) {
        return fail(`stored manifest for "${fileId}" is malformed: ${(e as Error).message}`);
      }
      if (!manifest) {
        return fail(`no file with ID "${fileId}".`);
      }
      const endpoints: StorageNodeEndpoint[] = parsed.nodes.map((baseUrl) => ({ id: baseUrl, baseUrl }));
      const runDelete = deps.deleteFileFn ?? deleteFile;
      try {
        const report = await runDelete(manifest, endpoints, { manifestStore: store });
        out(`Deleted file "${report.fileId}" (${report.totalPieces} piece(s) from ${endpoints.length} node(s)).`);
        return EXIT_OK;
      } catch (e) {
        const detail = (e as Error).message;
        return fail(`partial deletion failure: ${detail}`);
      }
    }

    err(`Error: unknown command "${parsed.positionals.join(" ") || "(none)"}".`);
    err(usage());
    return EXIT_USAGE;
  } catch (e) {
    return fail((e as Error).message);
  }
}

// Entrypoint when executed directly (`npx tsx apps/client/cli.ts ...`).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`Error: ${(e as Error).message}`);
      process.exitCode = EXIT_FAILURE;
    },
  );
}
