import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { verifyPayload, verifyStoredMessage, verifyStoredNote } from '../src/verify.js';
import { Identity } from '../src/identity.js';
import { base64urlEncode } from '../src/encoding.js';
import { didKeyFromPublicKey } from '../src/did.js';
import { RFC8032_ED25519, hexToBytes } from './vectors/external.js';

describe('verify - RFC 8032 known-answer verification', () => {
  it('accepts the published signature for the empty message', () => {
    // Every input here comes from the RFC: the public key, the message and the
    // signature. Nothing was produced by this library's signer.
    const vector = RFC8032_ED25519[0] as (typeof RFC8032_ED25519)[number];
    const did = didKeyFromPublicKey(hexToBytes(vector.publicKeyHex));
    const sig = base64urlEncode(hexToBytes(vector.signatureHex));
    expect(verifyPayload('', sig, did)).toBe(true);
  });

  it('accepts the published signature for the one-byte message', () => {
    const vector = RFC8032_ED25519[1] as (typeof RFC8032_ED25519)[number];
    const did = didKeyFromPublicKey(hexToBytes(vector.publicKeyHex));
    const sig = base64urlEncode(hexToBytes(vector.signatureHex));
    expect(verifyPayload('r', sig, did)).toBe(true);
  });

  it('rejects a published signature against the wrong published key', () => {
    const signer = RFC8032_ED25519[0] as (typeof RFC8032_ED25519)[number];
    const other = RFC8032_ED25519[1] as (typeof RFC8032_ED25519)[number];
    const sig = base64urlEncode(hexToBytes(signer.signatureHex));
    expect(verifyPayload('', sig, didKeyFromPublicKey(hexToBytes(other.publicKeyHex)))).toBe(false);
  });

  it('rejects a published signature against the wrong payload', () => {
    const vector = RFC8032_ED25519[1] as (typeof RFC8032_ED25519)[number];
    const did = didKeyFromPublicKey(hexToBytes(vector.publicKeyHex));
    const sig = base64urlEncode(hexToBytes(vector.signatureHex));
    expect(verifyPayload('s', sig, did)).toBe(false);
  });
});

describe('verify - verification needs no secret', () => {
  it('verifies a record given only the did, the record and the signature', () => {
    // The signer is discarded before verification: everything below is public
    // data of the kind any reader of a room receives.
    const { did, nonce, text, sig } = Identity.create().signMessage('lobby', '42', 'hello');
    expect(verifyStoredMessage({ room: 'lobby', nonce, text, did, sig })).toBe(true);
  });

  it('verifies a note record the same way', () => {
    const signed = Identity.create().signNote('room-owners', 'd-jobs', '5', 'did:key:zExample');
    expect(
      verifyStoredNote({
        namespace: 'room-owners',
        key: 'd-jobs',
        nonce: signed.nonce,
        value: signed.text,
        did: signed.did,
        sig: signed.sig,
      }),
    ).toBe(true);
  });

  it('does not import identity.ts', async () => {
    // The import graph is the enforcement: a verifier that reached for the
    // signing module could not honestly claim to need no secret.
    const source = await readFile(
      fileURLToPath(new URL('../src/verify.ts', import.meta.url)),
      'utf8',
    );
    const importLines = source
      .split('\n')
      .filter((line) => /^\s*import\b/.test(line) || /\bfrom\s+'/.test(line));
    expect(importLines.join('\n')).not.toMatch(/identity/);
    expect(source).not.toMatch(/from '\.\/identity\.js'/);
  });
});

describe('verify - what must be rejected', () => {
  const identity = Identity.create();
  const signed = identity.signMessage('lobby', '42', 'hello');
  const record = {
    room: 'lobby',
    nonce: signed.nonce,
    text: signed.text,
    did: signed.did,
    sig: signed.sig,
  };

  it('rejects a changed room, nonce or text', () => {
    expect(verifyStoredMessage({ ...record, room: 'meta' })).toBe(false);
    expect(verifyStoredMessage({ ...record, nonce: '43' })).toBe(false);
    expect(verifyStoredMessage({ ...record, text: 'hellO' })).toBe(false);
  });

  it('rejects a non-canonical spelling of an otherwise valid signature', () => {
    // STATED [SIGNING]: only the canonical encoding is accepted. Accepting the
    // other fifteen would call records valid that the server refused to store.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = alphabet.indexOf(signed.sig[85] as string);
    const variant = signed.sig.slice(0, 85) + (alphabet[last + 1] as string);
    expect(Buffer.from(variant, 'base64url')).toHaveLength(64);
    expect(verifyStoredMessage({ ...record, sig: variant })).toBe(false);
  });

  it('rejects a malformed did, sig or nonce without throwing', () => {
    expect(verifyStoredMessage({ ...record, did: 'did:key:nope' })).toBe(false);
    expect(verifyStoredMessage({ ...record, sig: 'short' })).toBe(false);
    expect(verifyStoredMessage({ ...record, nonce: 'abc' })).toBe(false);
    expect(verifyPayload('x', signed.sig, 'not-a-did')).toBe(false);
  });

  it('does not re-sweep the stored text', () => {
    // A record whose stored text still contained a sweepable character could
    // only have been written by something other than this server. Re-sweeping
    // would make it verify; using the bytes as received does not.
    const raw = 'a' + String.fromCharCode(0x200d) + 'b';
    const swept = 'a b';
    const forged = identity.signMessage('lobby', '1', raw);
    expect(forged.text).toBe(swept);
    expect(verifyStoredMessage({ room: 'lobby', nonce: '1', text: raw, did: forged.did, sig: forged.sig })).toBe(
      false,
    );
    expect(
      verifyStoredMessage({ room: 'lobby', nonce: '1', text: swept, did: forged.did, sig: forged.sig }),
    ).toBe(true);
  });
});
