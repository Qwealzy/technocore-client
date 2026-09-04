import { verify as cryptoVerify, createPublicKey, type KeyObject } from 'node:crypto';
import { base64urlDecodeCanonical, SIGNATURE_PATTERN } from './encoding.js';
import { publicKeyFromDidKey } from './did.js';
import { storedMessagePayload, storedNotePayload } from './payload.js';

/**
 * Offline verification of a stored record.
 *
 * This module deliberately does NOT import identity.ts and holds no private key
 * material of any kind. STATED [SIGNING / auth.md]: "resolution is offline —
 * the identifier is the key", so verifying somebody else's message needs their
 * did:key, the record, and nothing else. Keeping the import graph one-way is
 * what makes that checkable rather than merely claimed.
 */

/** SPKI DER header for an Ed25519 public key; the 32 raw bytes follow it. */
const ED25519_SPKI_HEADER = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

function publicKeyObjectFromDid(did: string): KeyObject {
  const raw = publicKeyFromDidKey(did);
  const der = new Uint8Array(ED25519_SPKI_HEADER.length + raw.length);
  der.set(ED25519_SPKI_HEADER, 0);
  der.set(raw, ED25519_SPKI_HEADER.length);
  return createPublicKey({ key: Buffer.from(der), format: 'der', type: 'spki' });
}

/**
 * Verifies a signature over an exact payload string.
 *
 * Returns false rather than throwing for every "does not verify" outcome,
 * including a malformed or non-canonical signature: to a caller deciding
 * whether to believe a record, all of those are the same answer.
 */
export function verifyPayload(payload: string, signature: string, did: string): boolean {
  if (!SIGNATURE_PATTERN.test(signature)) return false;
  let raw: Uint8Array;
  try {
    // STATED [SIGNING]: only the canonical spelling is accepted. A client that
    // accepted the other fifteen would call records valid that the server
    // refused to store.
    raw = base64urlDecodeCanonical(signature, 64);
  } catch {
    return false;
  }
  let key: KeyObject;
  try {
    key = publicKeyObjectFromDid(did);
  } catch {
    return false;
  }
  // Ed25519 takes no digest algorithm; the first argument must be null.
  return cryptoVerify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(raw));
}

export interface StoredMessage {
  readonly room: string;
  readonly nonce: string;
  /** The text as stored — already swept by the server. Do not sweep it again. */
  readonly text: string;
  readonly did: string;
  readonly sig: string;
}

/**
 * STATED [RENDERING]: a record with no `sig` is "not re-verifiable", NOT
 * invalid — records written before the field existed simply do not have one.
 * That distinction belongs to the caller, so this function takes a `sig` and
 * the caller decides what a missing one means.
 *
 * STATED [SIGNING]: `seq` and `ts` are assigned by the server and are not
 * signed, so they are absent here by design.
 */
export function verifyStoredMessage(record: StoredMessage): boolean {
  let payload: string;
  try {
    payload = storedMessagePayload(record.room, record.nonce, record.text);
  } catch {
    return false;
  }
  return verifyPayload(payload, record.sig, record.did);
}

export interface StoredNote {
  readonly namespace: string;
  readonly key: string;
  readonly nonce: string;
  /** The value as stored — already swept by the server. */
  readonly value: string;
  readonly did: string;
  readonly sig: string;
}

export function verifyStoredNote(record: StoredNote): boolean {
  let payload: string;
  try {
    payload = storedNotePayload(record.namespace, record.key, record.nonce, record.value);
  } catch {
    return false;
  }
  return verifyPayload(payload, record.sig, record.did);
}
