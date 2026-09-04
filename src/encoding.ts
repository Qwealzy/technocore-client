/**
 * The two codecs the protocol's identity layer rests on.
 *
 * Both are here rather than beside their callers because both are places where
 * a round-trip test passes while the implementation is wrong: encode and decode
 * can be inverse to each other and still disagree with everyone else. The tests
 * for this file are known-answer tests against externally published values.
 */

/** base58btc — the Bitcoin alphabet, as multibase 'z' requires. */
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const B58_INDEX: ReadonlyMap<string, number> = new Map(
  [...B58_ALPHABET].map((c, i) => [c, i] as const),
);

export function base58btcEncode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  // Byte-wise base-256 -> base-58 long division; no BigInt, so behaviour does
  // not depend on how large the input is.
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += (digits[i] as number) << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  // Every leading zero byte is one leading '1'; the long division above cannot
  // represent them, so they are restored explicitly.
  let leading = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    leading += B58_ALPHABET[0];
  }
  let out = '';
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i] as number];
  return leading + out;
}

export function base58btcDecode(text: string): Uint8Array {
  if (text.length === 0) return new Uint8Array(0);
  const bytes: number[] = [0];
  for (const char of text) {
    const value = B58_INDEX.get(char);
    if (value === undefined) {
      throw new Error(`base58btc: character ${JSON.stringify(char)} is not in the alphabet`);
    }
    let carry = value;
    for (let i = 0; i < bytes.length; i++) {
      carry += (bytes[i] as number) * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingZeros = 0;
  for (const char of text) {
    if (char !== B58_ALPHABET[0]) break;
    leadingZeros++;
  }
  const out = new Uint8Array(leadingZeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[leadingZeros + i] = bytes[bytes.length - 1 - i] as number;
  return out;
}

/**
 * STATED [SIGNING]: <sig> is "86 base64url characters, unpadded, and canonical
 * — sixteen strings decode to the same 64 bytes, so the last character must be
 * the one the encoder produces, always one of AQgw."
 *
 * 64 bytes is 512 bits; 85 characters carry 510 of them, so the 86th character
 * holds two significant bits and its low four bits are zero. That leaves
 * exactly four legal final characters: A(0) Q(16) g(32) w(48).
 */
export const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{85}[AQgw]$/;

export function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Decodes only the canonical encoding of `expectedBytes` length.
 *
 * Node's base64 decoder silently accepts the fifteen non-canonical spellings of
 * a 64-byte signature by discarding the stray low bits. The server does not, so
 * neither does this: the decoded bytes are re-encoded and compared, which is the
 * only check that catches every non-canonical variant rather than just the ones
 * a regex happens to describe.
 */
export function base64urlDecodeCanonical(text: string, expectedBytes?: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new Error('base64url: contains a character outside the unpadded base64url alphabet');
  }
  const decoded = new Uint8Array(Buffer.from(text, 'base64url'));
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new Error(`base64url: decoded ${decoded.length} bytes, expected ${expectedBytes}`);
  }
  if (base64urlEncode(decoded) !== text) {
    throw new Error('base64url: encoding is not canonical — re-encode the raw bytes rather than editing the tail');
  }
  return decoded;
}

/** True when `text` is a syntactically acceptable signature per the spec. */
export function isCanonicalSignature(text: string): boolean {
  if (!SIGNATURE_PATTERN.test(text)) return false;
  try {
    base64urlDecodeCanonical(text, 64);
    return true;
  } catch {
    return false;
  }
}
