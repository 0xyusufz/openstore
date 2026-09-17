import { createInterface } from "node:readline";
import { createIdentity, recoverIdentity } from "../identity/index.js";
import { createCoordinatorInstanceIdentity } from "./index.js";
import { createAuthorityGrantService, type SignedAuthorityGrant } from "./authority-grant.js";
import { createAuthorityIssuer } from "./authority-issuer.js";
import { createAuthorityOwnershipService } from "./authority-ownership.js";
import { createAuthorityControlPlane } from "./authority-control-plane.js";
import { createAuthorityRecoveryPolicy } from "./authority-recovery-policy.js";
import { createCoordinatorAuthorityRuntime } from "./runtime.js";

const dir = process.env.OPENSTORE_053P_DIR;
const issuerPhrase = process.env.OPENSTORE_053P_ISSUER_PHRASE;
const candidatePhrase = process.env.OPENSTORE_053P_CANDIDATE_PHRASE;
const policyPersistencePath = process.env.OPENSTORE_053Q_POLICY_PATH ?? `${dir}/recovery-policy.json`;
if (!dir || !issuerPhrase || !candidatePhrase) throw new Error("053P worker configuration is missing");

const issuerIdentity = recoverIdentity(issuerPhrase.split(" "));
const candidateIdentity = recoverIdentity(candidatePhrase.split(" "));
const issuerInstance = createCoordinatorInstanceIdentity(issuerIdentity.publicKey);
const candidateInstance = createCoordinatorInstanceIdentity(candidateIdentity.publicKey);
const revoked = new Set<string>();
const caller = "operator:053p";
const authorizer = { authenticate: (value: string) => value === caller, mayIssue: (value: string) => value === caller };
const state = () => ({ revision: 7, digest: "a".repeat(64), fresh: true });
const issuer = createAuthorityIssuer({
  identity: issuerIdentity, persistencePath: `${dir}/issuer.json`, authorizer,
});
const candidate = createAuthorityGrantService({
  instance: candidateInstance, trustedIssuerPublicKeys: [issuerIdentity.publicKey.toString("base64")],
  persistencePath: `${dir}/candidate-${candidateInstance.instanceId}.json`, state,
  revokedGrantIds: () => [...revoked],
});
const ownership = createAuthorityOwnershipService({
  instance: candidateInstance, issuerPrivateKey: issuerIdentity.privateKey,
  trustedIssuerPublicKeys: [issuerIdentity.publicKey.toString("base64")],
  persistencePath: `${dir}/ownership.json`, state, revokedGrantIds: () => [...revoked],
});
const recoveryPolicy = createAuthorityRecoveryPolicy({
  issuerIdentity,
  issuerInstanceId: issuerInstance.instanceId,
  candidateInstanceId: candidateInstance.instanceId,
  persistencePath: policyPersistencePath,
  now: () => Date.now(),
});
const controlPlane = createAuthorityControlPlane({
  issuer, candidate, ownership, candidateInstanceId: candidateInstance.instanceId,
  issuerInstanceId: issuerInstance.instanceId, revokedGrantIds: () => [...revoked],
  recoveryPolicy,
  issuerIdentity,
  recoveryPersistencePath: policyPersistencePath,
});
const runtime = createCoordinatorAuthorityRuntime({
  controlPlane, issuer, candidate, ownership, issuerInstanceId: issuerInstance.instanceId,
  recoveryPolicy,
});

function response(id: number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ id, ok: true, result })}\n`);
}
function failure(id: number, error: unknown): void {
  process.stdout.write(`${JSON.stringify({ id, ok: false, error: error instanceof Error ? error.message : "operation failed" })}\n`);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  void (async () => {
    const request = JSON.parse(line) as { id: number; operation: string; grant?: SignedAuthorityGrant; grantId?: string; reason?: string; evidence?: unknown; authorization?: unknown; action?: string; requestAuthorization?: unknown; };
    try {
      if (request.operation === "start") await runtime.start();
      else if (request.operation === "stop") { await runtime.stop(); lines.close(); }
      else if (request.operation === "bootstrap") await issuer.bootstrap(1);
      else if (request.operation === "issue") {
        const now = Date.now();
        const grant = await controlPlane.issueGrant({
          operation: "request-grant", version: 1, callerIdentity: caller,
          candidateInstanceId: candidateInstance.instanceId, authorityEpoch: 1,
          stateRevision: 7, stateDigest: "a".repeat(64), grantId: request.grantId ?? `grant-${now}`,
          issuedAt: now, expiresAt: now + 60_000,
        });
        response(request.id, grant);
        return;
      } else if (request.operation === "deliver") await controlPlane.deliverGrant(request.grant!);
      else if (request.operation === "accept") await controlPlane.acceptGrant(request.grantId!);
      else if (request.operation === "establish") await runtime.establishOwnership();
      else if (request.operation === "release") await runtime.releaseOwnership(request.reason ?? "operator");
      else if (request.operation === "fence") await runtime.fenceOwner(request.reason ?? "operator");
      else if (request.operation === "inspect") { response(request.id, runtime.status()); return; }
      else if (request.operation === "validate") { response(request.id, runtime.validateOwnershipToken(request.grant as never)); return; }
      else if (request.operation === "request-recovery-authorization") {
        const auth = await controlPlane.requestRecoveryAuthorization(request.requestAuthorization as never);
        response(request.id, auth);
        return;
      } else if (request.operation === "inspect-recovery") {
        const result = runtime.inspectRecovery(request.evidence as never);
        response(request.id, result);
        return;
      } else if (request.operation === "approve-recovery") {
        const result = controlPlane.approveRecovery(request.evidence as never, request.authorization as never);
        response(request.id, result);
        return;
      } else if (request.operation === "execute-explicit-recovery") {
        const result = controlPlane.executeExplicitRecoveryAction((request.action as "inspect" | "approve" | "reset" | "fence"), request.evidence as never, request.authorization as never);
        response(request.id, result);
        return;
      } else throw new Error("unknown 053P operation");
      response(request.id, true);
      if (request.operation === "stop") setImmediate(() => process.exit(0));
    } catch (error) {
      failure(request.id, error);
    }
  })();
});
