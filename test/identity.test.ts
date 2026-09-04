import { describe, expect, it } from 'vitest';
import { createPrivateKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { inspect } from 'node:util';
import { Identity } from '../src/identity.js';
import { base64urlEncode, SIGNATURE_PATTERN } from '../src/encoding.js';
import { didKeyFromPublicKey } from '../src/did.js';
import { RFC8032_ED25519, hexToBytes, bytesToHex } from './vectors/external.js';

describe('Identity - RFC 8032 known-answer signing', () => {
  for (const vector of RFC8032_ED25519) {
    it('derives the published public key for ' + vector.name, () => {
      const identity = Identity.fromSeed(hexToBytes(vector.secretKeyHex));
      expect(bytesToHex(identity.publicKey)).toBe(vector.publicKeyHex);
      expect(identity.did).toBe(didKeyFromPublicKey(hexToBytes(vector.publicKeyHex)));
    });

    it('produces the published signature for ' + vector.name, () => {
      // The payloads this library signs are always UTF-8 strings, while the RFC
      // expresses its messages as bytes, so the byte-level check goes through
      // node:crypto directly and the result is compared to the RFC's hex.
      // Both the key and the expected signature come from the RFC.
      const identity = Identity.fromSeed(hexToBytes(vector.secretKeyHex));
      const privateKey = createPrivateKey({
        key: Buffer.concat([
          Buffer.from('302e020100300506032b657004220420', 'hex'),
          Buffer.from(vector.secretKeyHex, 'hex'),
        ]),
        format: 'der',
        type: 'pkcs8',
      });
      const raw = cryptoSign(null, Buffer.from(vector.messageHex, 'hex'), privateKey);
      expect(bytesToHex(new Uint8Array(raw))).toBe(vector.signatureHex);
      if (vector.messageHex === '') {
        // An empty message is expressible as a payload string, so the
        // library's own string-to-signature path is checked against the RFC
        // value directly rather than only through node:crypto.
        expect(identity.sign('')).toBe(base64urlEncode(hexToBytes(vector.signatureHex)));
      }
    });
  }

  it('signs a UTF-8 payload to the RFC signature when the payload is the vector message', () => {
    // TEST 2's message is the single byte 0x72, which is the ASCII character
    // 'r'. That makes it expressible as a payload string, so this checks the
    // library's whole string-to-signature path against the RFC.
    const vector = RFC8032_ED25519[1] as (typeof RFC8032_ED25519)[number];
    expect(vector.messageHex).toBe('72');
    const identity = Identity.fromSeed(hexToBytes(vector.secretKeyHex));
    expect(identity.sign('r')).toBe(base64urlEncode(hexToBytes(vector.signatureHex)));
  });
});

describe('Identity - signature encoding is always canonical', () => {
  it('ends every signature with A, Q, g or w', () => {
    // STATED [SIGNING]: 64 bytes leave the last character's low four bits zero.
    // Property check across many keys and many payloads.
    const finals = new Set<string>();
    for (let key = 0; key < 12; key++) {
      const identity = Identity.create();
      for (let n = 0; n < 12; n++) {
        const sig = identity.signMessage('lobby', String(n + 1), 'message ' + n).sig;
        expect(sig).toHaveLength(86);
        expect(SIGNATURE_PATTERN.test(sig)).toBe(true);
        const last = sig[85] as string;
        expect(['A', 'Q', 'g', 'w']).toContain(last);
        finals.add(last);
      }
    }
    // Not a requirement, but if only one final character ever appeared the
    // property above would be passing for the wrong reason.
    expect(finals.size).toBeGreaterThan(1);
  });
});

describe('Identity - sweep happens before signing', () => {
  it('returns the swept text alongside the signature', () => {
    const identity = Identity.create();
    const signed = identity.signMessage('lobby', '1', '  a\u0000b  ');
    expect(signed.text).toBe('a b');
    expect(signed.sig).toBe(identity.sign('lobby|1|a b'));
    expect(signed.sig).not.toBe(identity.sign('lobby|1|  a\u0000b  '));
  });

  it('carries the did and the nonce through unchanged', () => {
    const identity = Identity.create();
    const signed = identity.signMessage('lobby', '9223372036854775807', 'hi');
    expect(signed.did).toBe(identity.did);
    expect(signed.nonce).toBe('9223372036854775807');
  });
});

describe('Identity - private key material never escapes', () => {
  // The seed is generated here, in the test, so the test knows exactly what
  // must never appear anywhere in the library's output.
  const seed = new Uint8Array(32).map((_, i) => (i * 37 + 5) & 0xff);
  const identity = Identity.fromSeed(seed);

  const secretSpellings: readonly string[] = [
    bytesToHex(seed),
    Buffer.from(seed).toString('base64'),
    Buffer.from(seed).toString('base64url'),
    Buffer.from(seed).toString('latin1'),
    // The PKCS#8 DER the class builds internally, in the two textual forms it
    // would take if it ever leaked.
    Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)])
      .toString('hex'),
    Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)])
      .toString('base64'),
  ];

  function assertClean(label: string, value: unknown): void {
    const rendered =
      typeof value === 'string' ? value : inspect(value, { depth: 8, showHidden: true });
    for (const secret of secretSpellings) {
      expect(rendered.includes(secret), label + ' leaked private key material').toBe(false);
    }
  }

  it('is absent from toString, toJSON, inspect and JSON.stringify', () => {
    assertClean('toString', identity.toString());
    assertClean('String()', String(identity));
    assertClean('toJSON', identity.toJSON());
    assertClean('JSON.stringify', JSON.stringify(identity));
    assertClean('inspect', inspect(identity));
    assertClean('inspect showHidden', inspect(identity, { depth: 10, showHidden: true }));
    assertClean('template literal', `${identity}`);
  });

  it('is absent from every enumerable and own property', () => {
    assertClean('Object.keys', Object.keys(identity));
    assertClean('Object.entries', Object.entries(identity));
    assertClean('getOwnPropertyNames', Object.getOwnPropertyNames(identity));
    assertClean('spread', { ...identity });
    for (const name of Object.getOwnPropertyNames(identity)) {
      assertClean('own property ' + name, (identity as unknown as Record<string, unknown>)[name]);
    }
  });

  it('is absent from the return value of every public method', () => {
    assertClean('publicKey', identity.publicKey);
    assertClean('did', identity.did);
    assertClean('sign', identity.sign('lobby|1|hi'));
    assertClean('signMessage', identity.signMessage('lobby', '1', 'hi'));
    assertClean('signNote', identity.signNote('ns', 'k', '1', 'v'));
  });

  it('is absent from error messages and stacks on every failure path', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\n' +
      Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        Buffer.from(seed),
      ]).toString('base64') +
      '\nnot-valid\n-----END PRIVATE KEY-----\n';

    const failures: readonly (() => unknown)[] = [
      () => Identity.fromSeed(seed.slice(0, 31)),
      () => Identity.fromPem(pem),
      () => Identity.fromPem('-----BEGIN PRIVATE KEY-----\ngarbage\n-----END PRIVATE KEY-----'),
      () => identity.signMessage('lobby', 'not-a-nonce', 'hi'),
      () => identity.signMessage('lobby', '1', '   '),
    ];

    for (const [index, failure] of failures.entries()) {
      let caught: unknown;
      try {
        failure();
      } catch (error) {
        caught = error;
      }
      expect(caught, 'failure ' + index + ' did not throw').toBeInstanceOf(Error);
      const error = caught as Error;
      assertClean('error message ' + index, error.message);
      assertClean('error stack ' + index, error.stack ?? '');
      assertClean('error inspect ' + index, error);
      // A `cause` chain is the usual way OpenSSL detail leaks back out.
      assertClean('error cause ' + index, (error as { cause?: unknown }).cause ?? '');
    }
  });

  it('rejects a non-Ed25519 key rather than mis-deriving a DID from it', () => {
    const { privateKey } = generateKeyPairSync('x25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
    expect(() => Identity.fromPem(pem)).toThrow(/expected an Ed25519 key/);
  });

  it('hands back a copy of the public key, not the internal buffer', () => {
    const first = identity.publicKey;
    first.fill(0);
    expect(bytesToHex(identity.publicKey)).not.toBe(bytesToHex(first));
  });
});
