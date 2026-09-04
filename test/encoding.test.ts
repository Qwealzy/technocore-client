import { describe, expect, it } from 'vitest';
import {
  base58btcEncode,
  base58btcDecode,
  base64urlEncode,
  base64urlDecodeCanonical,
  isCanonicalSignature,
  SIGNATURE_PATTERN,
} from '../src/encoding.js';
import { W3C_DID_KEY_ED25519, hexToBytes, bytesToHex } from './vectors/external.js';

const MULTIBASE_BODY = W3C_DID_KEY_ED25519.did.slice('did:key:z'.length);

describe('base58btc - known answers', () => {
  it('encodes the W3C multicodec-framed key to the published multibase body', () => {
    // The expected string is the W3C did:key identifier minus its 'did:key:z'
    // prefix. Nothing in this assertion was produced by this library.
    expect(base58btcEncode(hexToBytes(W3C_DID_KEY_ED25519.multicodecFramedHex))).toBe(
      MULTIBASE_BODY,
    );
  });

  it('decodes the published multibase body back to the framed bytes', () => {
    expect(bytesToHex(base58btcDecode(MULTIBASE_BODY))).toBe(
      W3C_DID_KEY_ED25519.multicodecFramedHex,
    );
  });

  it('represents each leading zero byte as a leading 1', () => {
    // The long division cannot carry leading zeros, so they are restored
    // explicitly; getting this wrong silently shortens some encodings.
    expect(base58btcEncode(Uint8Array.from([0, 0, 1]))).toBe('112');
    expect(bytesToHex(base58btcDecode('112'))).toBe('000001');
  });

  it('rejects the four characters excluded from the alphabet', () => {
    for (const char of ['0', 'O', 'I', 'l']) {
      expect(() => base58btcDecode(char)).toThrow(/not in the alphabet/);
    }
  });

  it('handles the empty input in both directions', () => {
    expect(base58btcEncode(new Uint8Array(0))).toBe('');
    expect(base58btcDecode('')).toHaveLength(0);
  });
});

describe('base64url - canonical signature encoding', () => {
  // STATED [SIGNING]: 86 characters, unpadded, and the final character must be
  // one of AQgw because a 64-byte value leaves its low four bits zero.
  it('encodes 64 bytes to 86 unpadded characters matching the spec pattern', () => {
    for (let fill = 0; fill < 256; fill += 7) {
      const encoded = base64urlEncode(new Uint8Array(64).fill(fill));
      expect(encoded).toHaveLength(86);
      expect(encoded).not.toContain('=');
      expect(SIGNATURE_PATTERN.test(encoded)).toBe(true);
    }
  });

  it('rejects all fifteen non-canonical spellings of one signature', () => {
    const canonical = base64urlEncode(new Uint8Array(64).fill(0xab));
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const lastIndex = alphabet.indexOf(canonical[85] as string);
    let rejected = 0;
    for (let low = 1; low < 16; low++) {
      const variant = canonical.slice(0, 85) + (alphabet[lastIndex + low] as string);
      // Node's own decoder accepts these by discarding the stray bits. The
      // server does not, so neither do we.
      expect(Buffer.from(variant, 'base64url')).toHaveLength(64);
      expect(() => base64urlDecodeCanonical(variant, 64)).toThrow(/not canonical/);
      expect(isCanonicalSignature(variant)).toBe(false);
      rejected++;
    }
    expect(rejected).toBe(15);
    expect(isCanonicalSignature(canonical)).toBe(true);
  });

  it('rejects a wrong length, padding, and non-alphabet characters', () => {
    expect(isCanonicalSignature(base64urlEncode(new Uint8Array(32)))).toBe(false);
    expect(isCanonicalSignature('='.repeat(86))).toBe(false);
    expect(isCanonicalSignature('+'.repeat(86))).toBe(false);
    expect(() => base64urlDecodeCanonical('!!', 64)).toThrow(
      /outside the unpadded base64url alphabet/,
    );
  });

  it('reports a length mismatch rather than truncating', () => {
    expect(() => base64urlDecodeCanonical(base64urlEncode(new Uint8Array(32)), 64)).toThrow(
      /decoded 32 bytes, expected 64/,
    );
  });

  it('round-trips arbitrary byte lengths', () => {
    for (const length of [1, 2, 3, 31, 32, 64]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 7 + 11) & 0xff);
      expect(base64urlDecodeCanonical(base64urlEncode(bytes), length)).toEqual(bytes);
    }
  });
});
