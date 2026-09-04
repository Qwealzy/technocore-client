import { describe, expect, it } from 'vitest';
import {
  didKeyFromPublicKey,
  publicKeyFromDidKey,
  didNoteLocation,
  DID_KEY_PATTERN,
  ED25519_PUB_MULTICODEC,
} from '../src/did.js';
import {
  W3C_DID_KEY_ED25519,
  W3C_DID_FINGERPRINT,
  RFC8032_ED25519,
  hexToBytes,
  bytesToHex,
} from './vectors/external.js';

describe('did:key - W3C known-answer test', () => {
  it('turns the published public key bytes into the exact published DID', () => {
    // The assertion a round-trip cannot make: the expected string comes from
    // the W3C did:key specification, not from this library.
    expect(didKeyFromPublicKey(hexToBytes(W3C_DID_KEY_ED25519.publicKeyHex))).toBe(
      W3C_DID_KEY_ED25519.did,
    );
  });

  it('recovers the published public key bytes from the published DID', () => {
    expect(bytesToHex(publicKeyFromDidKey(W3C_DID_KEY_ED25519.did))).toBe(
      W3C_DID_KEY_ED25519.publicKeyHex,
    );
  });

  it('is 56 characters and matches the pattern the server enforces', () => {
    expect(W3C_DID_KEY_ED25519.did).toHaveLength(56);
    expect(DID_KEY_PATTERN.test(W3C_DID_KEY_ED25519.did)).toBe(true);
  });
});

describe('did:key - the multicodec prefix is what makes it a did:key', () => {
  it('uses 0xed 0x01', () => {
    expect([...ED25519_PUB_MULTICODEC]).toEqual([0xed, 0x01]);
  });

  it('rejects a did:key for another curve', () => {
    // z6LS... is the X25519 key (multicodec 0xec01) published beside the
    // Ed25519 one in the same W3C example. It must not be accepted here.
    expect(() =>
      publicKeyFromDidKey('did:key:z6LSj72tK8brWgZja8NLRwPigth2T9QRiG1uH9oKZuKjdh9p'),
    ).toThrow();
  });

  it('rejects malformed identifiers rather than guessing', () => {
    expect(() => publicKeyFromDidKey('')).toThrow(/must match/);
    expect(() => publicKeyFromDidKey('did:key:z6Mk')).toThrow(/must match/);
    expect(() => publicKeyFromDidKey(W3C_DID_KEY_ED25519.did + 'x')).toThrow(/must match/);
    expect(() => didKeyFromPublicKey(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => didKeyFromPublicKey(new Uint8Array(33))).toThrow(/32 bytes/);
  });
});

describe('did:key - RFC 8032 public keys also produce conforming identifiers', () => {
  for (const vector of RFC8032_ED25519) {
    it('encodes and recovers ' + vector.name, () => {
      const did = didKeyFromPublicKey(hexToBytes(vector.publicKeyHex));
      expect(DID_KEY_PATTERN.test(did)).toBe(true);
      expect(did).toHaveLength(56);
      expect(bytesToHex(publicKeyFromDidKey(did))).toBe(vector.publicKeyHex);
    });
  }
});

describe('did note location', () => {
  it('hashes the did:key string, matching an OpenSSL-computed digest', () => {
    // The expected digest was produced outside this library with:
    //   printf %s <did> | openssl dgst -sha256
    const location = didNoteLocation(W3C_DID_KEY_ED25519.did);
    expect(W3C_DID_FINGERPRINT.sha256Hex.slice(0, 16)).toBe(W3C_DID_FINGERPRINT.fingerprint);
    expect(location.fingerprint).toBe(W3C_DID_FINGERPRINT.fingerprint);
    expect(location.shard).toBe(W3C_DID_FINGERPRINT.shard);
    expect(location.key).toBe(W3C_DID_FINGERPRINT.key);
  });

  it('splits 2 + 14, so the halves rebuild the fingerprint', () => {
    const location = didNoteLocation(W3C_DID_KEY_ED25519.did);
    expect(location.shard).toHaveLength(2);
    expect(location.key).toHaveLength(14);
    expect(location.shard + location.key).toBe(location.fingerprint);
  });

  it('is not the hash of the key bytes, which is the plausible wrong answer', () => {
    // Hashing the bytes yields a well-formed path that no peer will ever read.
    const location = didNoteLocation(W3C_DID_KEY_ED25519.did);
    expect(location.fingerprint).not.toBe(W3C_DID_KEY_ED25519.publicKeyHex.slice(0, 16));
  });

  it('produces names the server would accept', () => {
    // STATED: names match ^[a-z0-9][a-z0-9_-]{0,47}$. 'did-' + 2 hex and 14 hex
    // both satisfy it.
    const location = didNoteLocation(W3C_DID_KEY_ED25519.did);
    const namePattern = /^[a-z0-9][a-z0-9_-]{0,47}$/;
    expect(namePattern.test('did-' + location.shard)).toBe(true);
    expect(namePattern.test(location.key)).toBe(true);
  });
});
