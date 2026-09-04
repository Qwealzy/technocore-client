import { createHash } from 'node:crypto';
import { base58btcEncode, base58btcDecode } from './encoding.js';

/**
 * did:key for Ed25519.
 *
 * STATED [SIGNING]: "<did> is did:key:z6Mk... — Ed25519 only (multibase
 * base58btc, multicodec ed25519-pub)."
 * STATED [CLAUDE.md / openapi]: multicodec 0xed01 + 32 raw public key bytes,
 * base58btc, 'z' prefix; the whole identifier is exactly 56 characters.
 *
 * The trap this file exists to prevent: base58-encoding the bare 32 bytes
 * produces a plausible-looking `z...` string that is a different identity. The
 * two-byte multicodec prefix is what makes it a did:key.
 */

/**
 * ed25519-pub, varint-encoded: 0xed 0x01.
 *
 * Not frozen — Object.freeze throws on a non-empty typed array. Treat it as
 * read-only; nothing in this package writes to it.
 */
export const ED25519_PUB_MULTICODEC: Uint8Array = Uint8Array.from([0xed, 0x01]);

/** STATED [openapi]: ^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$, exactly 56 chars. */
export const DID_KEY_PATTERN = /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$/;

const DID_KEY_PREFIX = 'did:key:';
const MULTIBASE_BASE58BTC = 'z';

export function didKeyFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error(`did:key: an Ed25519 public key is 32 bytes, got ${publicKey.length}`);
  }
  const framed = new Uint8Array(ED25519_PUB_MULTICODEC.length + publicKey.length);
  framed.set(ED25519_PUB_MULTICODEC, 0);
  framed.set(publicKey, ED25519_PUB_MULTICODEC.length);
  const did = DID_KEY_PREFIX + MULTIBASE_BASE58BTC + base58btcEncode(framed);
  // Belt and braces: a correct key can only produce a conforming identifier, so
  // a failure here means the codec is wrong, not the input.
  if (!DID_KEY_PATTERN.test(did)) {
    throw new Error('did:key: encoding did not produce a conforming identifier');
  }
  return did;
}

export function publicKeyFromDidKey(did: string): Uint8Array {
  if (!DID_KEY_PATTERN.test(did)) {
    throw new Error('did:key: must match ^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$');
  }
  const framed = base58btcDecode(did.slice(DID_KEY_PREFIX.length + MULTIBASE_BASE58BTC.length));
  if (framed.length !== ED25519_PUB_MULTICODEC.length + 32) {
    throw new Error(`did:key: expected 34 multicodec-framed bytes, got ${framed.length}`);
  }
  if (framed[0] !== ED25519_PUB_MULTICODEC[0] || framed[1] !== ED25519_PUB_MULTICODEC[1]) {
    // Reached by a did:key for some other curve — X25519 is 0xec01, secp256k1
    // 0xe701. STATED [SIGNING]: "Ed25519 only".
    throw new Error('did:key: multicodec prefix is not ed25519-pub (0xed01)');
  }
  return framed.slice(ED25519_PUB_MULTICODEC.length);
}

export interface DidNoteLocation {
  /** The full 16-character fingerprint. */
  readonly fingerprint: string;
  /** First 2 characters — the namespace shard. */
  readonly shard: string;
  /** Remaining 14 characters — the note key. */
  readonly key: string;
}

/**
 * STATED [IDENTITY]: "Fingerprint = the first 16 lowercase hex characters of
 * SHA-256(did:key string); new notes use /kv/did-<first 2>/<remaining 14>."
 *
 * The hash is over the did:key STRING, not over the public key bytes. Hashing
 * the bytes yields a well-formed path that no peer will ever read.
 *
 * This computes the location only. STATED [IDENTITY]: readers try the sharded
 * path, then the legacy /kv/did/<fingerprint> path — that fallback belongs to
 * the notes layer, which is not part of this release.
 */
export function didNoteLocation(did: string): DidNoteLocation {
  if (!DID_KEY_PATTERN.test(did)) {
    throw new Error('did:key: must match ^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$');
  }
  const fingerprint = createHash('sha256').update(did, 'utf8').digest('hex').slice(0, 16);
  return { fingerprint, shard: fingerprint.slice(0, 2), key: fingerprint.slice(2) };
}
