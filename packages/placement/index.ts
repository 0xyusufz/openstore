/**
 * OpenStore Shared Placement Eligibility (069 hardening)
 *
 * Genuinely shared placement/capacity validation primitive extracted from
 * `apps/client/selection.ts` so both the client selection path and the
 * backend-authoritative marketplace use the same authoritative rules.
 *
 * - Draining/released never eligible.
 * - Capabilities (pieceStore, maxPieceBytes) enforced.
 * - Trusted capacity (allocated/used/available) validated; available must cover pieceSize.
 * - Package has no dependency on `apps/*`; both sides import from here.
 */

export interface PlacementCapacity {
  allocatedBytes?: number;
  totalBytes?: number;
  usedBytes: number;
  availableBytes: number;
}

export interface PlacementCandidate {
  lifecycle?: "sharing" | "draining" | "released" | string;
  available?: boolean;
  capacity?: PlacementCapacity;
  capabilities?: {
    pieceStore?: boolean;
    maxPieceBytes?: number;
  };
}

/**
 * Shared target admission predicate for placement, repair, and marketplace.
 * Reuses the authoritative 013 placement rules.
 */
export function isPlacementEligible(
  candidate: PlacementCandidate | null | undefined,
  pieceSize: number,
  requireTrustedCapacity = true,
): boolean {
  if (!candidate || (candidate as { lifecycle?: string }).lifecycle === "draining" || (candidate as { lifecycle?: string }).lifecycle === "released") return false;
  if (candidate.capabilities?.pieceStore === false) return false;
  if (
    candidate.capabilities?.maxPieceBytes !== undefined &&
    (!Number.isSafeInteger(candidate.capabilities.maxPieceBytes) || (candidate.capabilities.maxPieceBytes as number) < pieceSize)
  )
    return false;
  if (candidate.capacity === undefined) return !requireTrustedCapacity;
  const cap = candidate.capacity as PlacementCapacity;
  const allocated = cap.allocatedBytes ?? cap.totalBytes;
  const { usedBytes, availableBytes } = cap;
  if (allocated === undefined) {
    return (
      !requireTrustedCapacity &&
      (candidate as { lifecycle?: string }).lifecycle === undefined &&
      Number.isSafeInteger(usedBytes) &&
      usedBytes >= 0 &&
      Number.isSafeInteger(availableBytes) &&
      availableBytes >= 0 &&
      pieceSize <= availableBytes
    );
  }
  if (
    allocated === undefined ||
    !Number.isSafeInteger(allocated) ||
    allocated <= 0 ||
    !Number.isSafeInteger(usedBytes) ||
    usedBytes < 0 ||
    !Number.isSafeInteger(availableBytes) ||
    availableBytes < 0 ||
    usedBytes > allocated ||
    availableBytes > allocated ||
    usedBytes > Number.MAX_SAFE_INTEGER - availableBytes ||
    usedBytes + availableBytes > allocated
  )
    return false;
  return pieceSize >= 0 && pieceSize <= availableBytes;
}

/** Capacity-only check reused by `selectAvailableNodes`. */
export function hasTrustedCapacity(capacity: PlacementCapacity, pieceSize: number): boolean {
  const allocated = capacity.allocatedBytes ?? capacity.totalBytes;
  const values = [allocated, capacity.usedBytes, capacity.availableBytes];
  if (allocated === undefined || allocated <= 0 || values.some((v) => v === undefined || !Number.isSafeInteger(v as number) || (v as number) < 0)) return false;
  if (capacity.usedBytes > (allocated as number) || capacity.availableBytes > (allocated as number)) return false;
  if (capacity.usedBytes > Number.MAX_SAFE_INTEGER - capacity.availableBytes) return false;
  if (capacity.usedBytes + capacity.availableBytes > (allocated as number)) return false;
  return pieceSize <= capacity.availableBytes && pieceSize <= Number.MAX_SAFE_INTEGER - capacity.usedBytes;
}
