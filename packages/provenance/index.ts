export type PieceClaimKind = "upload" | "repair";
export type PieceClaimState = "pending" | "referenced" | "released";
export type OperationState =
  | "prepared"
  | "stored"
  | "verified"
  | "committed"
  | "release-requested"
  | "released";

export interface PieceClaim {
  pieceId: string;
  claimId: string;
  operationId: string;
  clientNamespace: string;
  kind: PieceClaimKind;
  state: PieceClaimState;
  createdAt: number;
  updatedAt: number;
}

export interface OperationRecord {
  operationId: string;
  pieceId: string;
  claimId: string;
  targetNodeId: string;
  kind: PieceClaimKind;
  expectedManifestRevision: number;
  state: OperationState;
  createdAt: number;
  updatedAt: number;
}

export type DeleteIfUnclaimedResult =
  | { status: "deleted" }
  | { status: "still-claimed"; claims: PieceClaim[] }
  | { status: "not-found" }
  | { status: "conflict" };

const ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const PIECE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function createOpaqueId(bytes = 16): string {
  if (!Number.isSafeInteger(bytes) || bytes < 16 || bytes > 64) {
    throw new RangeError("opaque ID byte length is invalid");
  }
  return randomBytes(bytes).toString("hex");
}

export function validatePieceClaim(claim: PieceClaim): void {
  if (!claim || typeof claim !== "object") throw new TypeError("claim must be an object");
  if (!PIECE_PATTERN.test(claim.pieceId)) throw new TypeError("claim pieceId is invalid");
  for (const [name, value] of [["claimId", claim.claimId], ["operationId", claim.operationId]] as const) {
    if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new TypeError(`claim ${name} is invalid`);
  }
  if (typeof claim.clientNamespace !== "string" || !/^[A-Za-z0-9+/=_-]{16,256}$/.test(claim.clientNamespace)) throw new TypeError("claim clientNamespace is invalid");
  if (claim.kind !== "upload" && claim.kind !== "repair") throw new TypeError("claim kind is invalid");
  if (!["pending", "referenced", "released"].includes(claim.state)) throw new TypeError("claim state is invalid");
  if (!Number.isSafeInteger(claim.createdAt) || claim.createdAt <= 0 || !Number.isSafeInteger(claim.updatedAt) || claim.updatedAt < claim.createdAt) {
    throw new TypeError("claim timestamps are invalid");
  }
}

export function validateOperationRecord(record: OperationRecord): void {
  if (!record || typeof record !== "object") throw new TypeError("operation record must be an object");
  for (const [name, value] of [["operationId", record.operationId], ["claimId", record.claimId]] as const) {
    if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new TypeError(`operation ${name} is invalid`);
  }
  if (typeof record.targetNodeId !== "string" || record.targetNodeId.length === 0 || record.targetNodeId.length > 512) {
    throw new TypeError("operation targetNodeId is invalid");
  }
  if (!PIECE_PATTERN.test(record.pieceId)) throw new TypeError("operation pieceId is invalid");
  if (record.kind !== "upload" && record.kind !== "repair") throw new TypeError("operation kind is invalid");
  if (!Number.isSafeInteger(record.expectedManifestRevision) || record.expectedManifestRevision < 0) throw new TypeError("operation revision is invalid");
  if (!["prepared", "stored", "verified", "committed", "release-requested", "released"].includes(record.state)) throw new TypeError("operation state is invalid");
  if (!Number.isSafeInteger(record.createdAt) || record.createdAt <= 0 || !Number.isSafeInteger(record.updatedAt) || record.updatedAt < record.createdAt) throw new TypeError("operation timestamps are invalid");
}

export function canTransitionClaim(from: PieceClaimState, to: PieceClaimState): boolean {
  return from === to || (from === "pending" && (to === "referenced" || to === "released")) || (from === "referenced" && to === "released");
}

export function canTransitionOperation(from: OperationState, to: OperationState): boolean {
  return from === to ||
    (from === "prepared" && (to === "stored" || to === "release-requested")) ||
    (from === "stored" && (to === "verified" || to === "release-requested")) ||
    (from === "verified" && (to === "committed" || to === "release-requested")) ||
    (from === "release-requested" && to === "released");
}
import { randomBytes } from "crypto";
