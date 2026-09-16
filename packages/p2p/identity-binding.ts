import { peerIdFromPrivateKey, peerIdFromPublicKey } from "@libp2p/peer-id";
import { privateKeyFromRaw, publicKeyFromRaw } from "@libp2p/crypto/keys";

const ED25519_PUBLIC_KEY_BYTES = 32;
const ED25519_SEED_BYTES = 32;

export function peerIdFromOpenStorePublicKey(publicKeyDer: Uint8Array): string {
  const raw = extractPublicKey(publicKeyDer);
  return peerIdFromPublicKey(publicKeyFromRaw(raw)).toString();
}

export function peerIdFromOpenStorePrivateKey(privateKeyDer: Uint8Array, publicKeyDer: Uint8Array): string {
  const publicRaw = extractPublicKey(publicKeyDer);
  const seed = extractPrivateSeed(privateKeyDer);
  const privateKey = privateKeyFromRaw(Buffer.concat([seed, publicRaw]));
  try {
    return peerIdFromPrivateKey(privateKey).toString();
  } finally {
    seed.fill(0);
  }
}

export function assertPeerIdMatchesOpenStoreIdentity(peerId: string, publicKeyDer: Uint8Array): void {
  if (peerIdFromOpenStorePublicKey(publicKeyDer) !== peerId) {
    throw new TypeError("libp2p peer identity does not match OpenStore identity");
  }
}

function extractPublicKey(value: Uint8Array): Buffer {
  if (value.length !== 44) throw new TypeError("OpenStore public key is invalid");
  return Buffer.from(value.slice(-ED25519_PUBLIC_KEY_BYTES));
}

function extractPrivateSeed(value: Uint8Array): Buffer {
  if (value.length !== 48) throw new TypeError("OpenStore private key is invalid");
  return Buffer.from(value.slice(-ED25519_SEED_BYTES));
}
