import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createIdentity } from "../identity/index.js";
import { createCoordinatorInstanceIdentity } from "./index.js";

interface Reply { id: number; ok: boolean; result?: any; error?: string }

function worker(dir: string, issuerPhrase: string, candidatePhrase: string): { process: ChildProcessWithoutNullStreams; command: (operation: string, extra?: Record<string, unknown>) => Promise<Reply> } {
  const child = spawn(process.execPath, ["--import", "tsx", "packages/coordinator-ha/runtime-process-worker.ts"], {
    cwd: process.cwd(), env: { ...process.env, OPENSTORE_053P_DIR: dir, OPENSTORE_053P_ISSUER_PHRASE: issuerPhrase, OPENSTORE_053P_CANDIDATE_PHRASE: candidatePhrase },
  });
  const input = createInterface({ input: child.stdout });
  const replies = new Map<number, (reply: Reply) => void>();
  input.on("line", (line) => { const reply = JSON.parse(line) as Reply; replies.get(reply.id)?.(reply); replies.delete(reply.id); });
  let nextId = 1;
  return {
    process: child,
    command: (operation, extra = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      replies.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ id, operation, ...extra })}\n`, (error) => { if (error) reject(error); });
    }),
  };
}

async function stop(runtime: ReturnType<typeof worker>): Promise<void> {
  await runtime.command("stop");
  await new Promise<void>((resolve) => runtime.process.once("exit", () => resolve()));
}

describe("053P cross-process authority recovery", () => {
  it("restores authority and ownership across process restart without new issuance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openstore-053p-"));
    const issuer = createIdentity();
    const candidate = createIdentity();
    const first = worker(dir, issuer.recoveryPhrase.join(" "), candidate.recoveryPhrase.join(" "));
    expect((await first.command("bootstrap")).ok).toBe(true);
    expect((await first.command("start")).ok).toBe(true);
    const grant = await first.command("issue", { grantId: "cross-process-grant" });
    expect(grant.ok).toBe(true);
    await first.command("deliver", { grant: grant.result });
    await first.command("accept", { grantId: "cross-process-grant" });
    await first.command("establish");
    const before = (await first.command("inspect")).result;
    await stop(first);
    const restarted = worker(dir, issuer.recoveryPhrase.join(" "), candidate.recoveryPhrase.join(" "));
    expect((await restarted.command("start")).ok).toBe(true);
    const after = (await restarted.command("inspect")).result;
    expect(after.authority.placementAuthorized).toBe(true);
    expect(after.candidateState.acceptedGrantId).toBe(before.candidateState.acceptedGrantId);
    expect(after.ownership.tokenId).toBe(before.ownership.tokenId);
    await stop(restarted);
  });

  it("fails closed for missing/corrupt persistence and cross-state mismatch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openstore-053p-fail-"));
    const issuer = createIdentity();
    const candidate = createIdentity();
    const first = worker(dir, issuer.recoveryPhrase.join(" "), candidate.recoveryPhrase.join(" "));
    await first.command("bootstrap"); await first.command("start");
    const grant = await first.command("issue", { grantId: "recovery-grant" });
    await first.command("deliver", { grant: grant.result }); await first.command("accept", { grantId: "recovery-grant" }); await first.command("establish");
    await stop(first);
    const issuerContents = readFileSync(join(dir, "issuer.json"), "utf8");
    const candidateId = createCoordinatorInstanceIdentity(candidate.publicKey).instanceId;
    const candidatePath = join(dir, `candidate-${candidateId}.json`);
    const candidateContents = readFileSync(candidatePath, "utf8");
    const ownershipPath = join(dir, "ownership.json");
    const ownershipContents = readFileSync(ownershipPath, "utf8");
    unlinkSync(join(dir, "issuer.json"));
    const missing = worker(dir, issuer.recoveryPhrase.join(" "), candidate.recoveryPhrase.join(" "));
    const missingStart = await missing.command("start");
    expect(missingStart.ok).toBe(true);
    expect((await missing.command("inspect")).result.authority.placementAuthorized).toBe(false);
    await stop(missing);

    writeFileSync(join(dir, "issuer.json"), "{corrupt", "utf8");
    const corruptIssuer = worker(dir, issuer.recoveryPhrase.join(" "), candidate.recoveryPhrase.join(" "));
    expect((await corruptIssuer.command("start")).ok).toBe(false);
    await stop(corruptIssuer);

    writeFileSync(join(dir, "issuer.json"), issuerContents, "utf8");
    writeFileSync(candidatePath, "{corrupt", "utf8");
    const corruptCandidate = worker(dir, issuer.recoveryPhrase.join(" "), candidate.recoveryPhrase.join(" "));
    expect((await corruptCandidate.command("start")).ok).toBe(false);
    await stop(corruptCandidate);

    writeFileSync(candidatePath, candidateContents, "utf8");
    unlinkSync(candidatePath);
    const missingCandidate = worker(dir, issuer.recoveryPhrase.join(" "), candidate.recoveryPhrase.join(" "));
    expect((await missingCandidate.command("start")).ok).toBe(false);
    expect((await missingCandidate.command("inspect")).result.authority.placementAuthorized).toBe(false);
    await stop(missingCandidate);
    writeFileSync(candidatePath, candidateContents, "utf8");

    unlinkSync(ownershipPath);
    const missingOwnership = worker(dir, issuer.recoveryPhrase.join(" "), candidate.recoveryPhrase.join(" "));
    expect((await missingOwnership.command("start")).ok).toBe(true);
    expect((await missingOwnership.command("inspect")).result.authority.placementAuthorized).toBe(false);
    await stop(missingOwnership);
    writeFileSync(ownershipPath, ownershipContents, "utf8");

    writeFileSync(ownershipPath, "{corrupt", "utf8");
    const corruptOwnership = worker(dir, issuer.recoveryPhrase.join(" "), candidate.recoveryPhrase.join(" "));
    expect((await corruptOwnership.command("start")).ok).toBe(false);
    await stop(corruptOwnership);
    writeFileSync(ownershipPath, ownershipContents, "utf8");

    const epochMismatch = JSON.parse(issuerContents) as { authorityEpoch: number };
    epochMismatch.authorityEpoch = 2;
    writeFileSync(join(dir, "issuer.json"), JSON.stringify(epochMismatch), "utf8");
    const mismatchedIssuer = worker(dir, issuer.recoveryPhrase.join(" "), candidate.recoveryPhrase.join(" "));
    expect((await mismatchedIssuer.command("start")).ok).toBe(false);
    await stop(mismatchedIssuer);
    writeFileSync(join(dir, "issuer.json"), issuerContents, "utf8");

    const ownershipMismatch = JSON.parse(ownershipContents) as { authorityEpoch: number; issuerInstanceId: string };
    ownershipMismatch.authorityEpoch = 2;
    writeFileSync(ownershipPath, JSON.stringify(ownershipMismatch), "utf8");
    const mismatchedOwnership = worker(dir, issuer.recoveryPhrase.join(" "), candidate.recoveryPhrase.join(" "));
    expect((await mismatchedOwnership.command("start")).ok).toBe(false);
    await stop(mismatchedOwnership);
    ownershipMismatch.authorityEpoch = 1;
    ownershipMismatch.issuerInstanceId = "coord-11111111111111111111111111111111";
    writeFileSync(ownershipPath, JSON.stringify(ownershipMismatch), "utf8");
    const wrongIssuer = worker(dir, issuer.recoveryPhrase.join(" "), candidate.recoveryPhrase.join(" "));
    expect((await wrongIssuer.command("start")).ok).toBe(false);
    await stop(wrongIssuer);
  }, 20_000);

  it("keeps fencing and release across restart and never promotes a second process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openstore-053p-split-"));
    const issuer = createIdentity();
    const candidateA = createIdentity();
    const candidateB = createIdentity();
    const a = worker(dir, issuer.recoveryPhrase.join(" "), candidateA.recoveryPhrase.join(" "));
    await a.command("bootstrap"); await a.command("start");
    const grantA = await a.command("issue", { grantId: "grant-a" });
    await a.command("deliver", { grant: grantA.result }); await a.command("accept", { grantId: "grant-a" }); await a.command("establish");
    const b = worker(dir, issuer.recoveryPhrase.join(" "), candidateB.recoveryPhrase.join(" "));
    expect((await b.command("start")).ok).toBe(false);
    await a.command("fence");
    expect((await a.command("inspect")).result.ownership.state).toBe("fenced");
    await a.command("release");
    expect((await a.command("establish")).ok).toBe(false);
    await stop(a);
    const restartedA = worker(dir, issuer.recoveryPhrase.join(" "), candidateA.recoveryPhrase.join(" "));
    expect((await restartedA.command("start")).ok).toBe(true);
    expect((await restartedA.command("inspect")).result.ownership.state).toBe("released");
    await stop(restartedA); await stop(b);
  });

  it("requires the same authorization to stay bound to one candidate and cannot create two authority owners", async () => {
    const dir = mkdtempSync(join(tmpdir(), "openstore-053q-dual-owner-"));
    const issuer = createIdentity();
    const candidateA = createIdentity();
    const candidateB = createIdentity();
    const issuerInstanceId = createCoordinatorInstanceIdentity(issuer.publicKey).instanceId;
    const candidateAInstanceId = createCoordinatorInstanceIdentity(candidateA.publicKey).instanceId;
    const candidateBInstanceId = createCoordinatorInstanceIdentity(candidateB.publicKey).instanceId;
    const a = worker(dir, issuer.recoveryPhrase.join(" "), candidateA.recoveryPhrase.join(" "));
    const b = worker(dir, issuer.recoveryPhrase.join(" "), candidateB.recoveryPhrase.join(" "));

    expect((await a.command("bootstrap")).ok).toBe(true);
    expect((await a.command("start")).ok).toBe(true);
    const grantA = await a.command("issue", { grantId: "grant-dual-owner-a" });
    expect(grantA.ok).toBe(true);
    await a.command("deliver", { grant: grantA.result });
    await a.command("accept", { grantId: "grant-dual-owner-a" });
    await a.command("establish");

    const authorizationRequest = {
      version: 1,
      candidateInstanceId: candidateAInstanceId,
      authorityEpoch: 1,
      stateRevision: 7,
      stateDigest: "a".repeat(64),
      issuerInstanceId: issuerInstanceId,
      operatorIdentity: "operator:dual-owner",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const authorizationResult = await a.command("request-recovery-authorization", { requestAuthorization: authorizationRequest });
    expect(authorizationResult.ok).toBe(true);
    const authorization = authorizationResult.result;
    expect(authorization.candidateInstanceId).toBe(candidateAInstanceId);

    expect((await b.command("start")).ok).toBe(true);

    const bEvidence = {
      version: 1,
      issuerInstanceId: issuerInstanceId,
      issuerInitialized: true,
      issuerPersistenceState: "valid",
      candidateInstanceId: candidateBInstanceId,
      authorityEpoch: 1,
      candidateEpoch: 1,
      candidateState: "non-authoritative",
      ownershipState: "non-authoritative",
      ownershipEpoch: 1,
      ownerInstanceId: candidateBInstanceId,
      stateRevision: 7,
      stateDigest: "a".repeat(64),
      stateFresh: true,
      validGrant: true,
      grantRevoked: false,
      issuerIdentityMatches: true,
      persistedStateHealthy: true,
      activeOwnershipConflict: false,
    };

    const bRejected = await b.command("approve-recovery", { evidence: bEvidence, authorization });
    expect(bRejected.ok).toBe(false);
    expect(String(bRejected.error)).toMatch(/invalid|mismatch|candidate|binding|epoch/i);

    const bExplicitRejected = await b.command("execute-explicit-recovery", {
      action: "approve",
      evidence: bEvidence,
      authorization,
    });
    expect(bExplicitRejected.ok).toBe(false);
    expect(String(bExplicitRejected.error)).toMatch(/invalid|mismatch|candidate|binding|epoch/i);

    const statusA = (await a.command("inspect")).result;
    const statusB = (await b.command("inspect")).result;
    expect(statusA.authority.placementAuthorized).toBe(true);
    expect(statusA.ownership.state).toBe("authoritative");
    expect(statusB.authority.placementAuthorized).toBe(false);
    expect(statusB.ownership.state).toBe("non-authoritative");

    const replay = await b.command("approve-recovery", { evidence: bEvidence, authorization });
    expect(replay.ok).toBe(false);
    expect(String(replay.error)).toMatch(/invalid|mismatch|candidate|binding|epoch/i);

    await stop(a);
    await stop(b);
  });
});
