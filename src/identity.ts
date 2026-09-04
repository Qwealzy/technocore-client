import { readFile } from 'node:fs/promises';
import { inspect } from 'node:util';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import { base64urlEncode } from './encoding.js';
import { didKeyFromPublicKey } from './did.js';
import { messagePayload, notePayload, type Signable } from './payload.js';

/**
 * The only module in this package that holds private key material.
 *
 * Everything about it is arranged so that "the private key is never returned,
 * never logged, and never appears in an error message" is a property of the
 * code rather than a promise in a README:
 *   - the key lives in a `#` private field, unreachable from outside the class
 *     and invisible to Object.keys, JSON.stringify and the spread operator;
 *   - toString, toJSON and the util.inspect hook are all overridden to emit the
 *     did:key and nothing else;
 *   - every failure path throws a message this file wrote, never one built from
 *     key bytes, a PEM body, or a passphrase.
 *
 * verify.ts does not import this module: verifying somebody else's record needs
 * no secret at all.
 */

/** PKCS#8 DER wrapper for a raw 32-byte Ed25519 seed. */
const ED25519_PKCS8_HEADER = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

/** SPKI DER header length; the 32 raw public key bytes follow it. */
const ED25519_SPKI_HEADER_LENGTH = 12;

/**
 * Supplies a passphrase when one is needed.
 *
 * A passphrase is never a parameter of these constructors, and never something
 * this library writes down. The caller provides a function that obtains it —
 * interactively, from an agent, from an OS keychain — and the value is used
 * once and dropped. It is never stored on the Identity, never logged, and never
 * placed in an error message.
 */
export type PassphraseProvider = () => string | Promise<string>;

export interface SignedText {
  readonly did: string;
  readonly nonce: string;
  /** The swept text — the bytes that were signed and the bytes to send. */
  readonly text: string;
  /** Canonical base64url, 86 characters, final character one of A Q g w. */
  readonly sig: string;
}

function rawPublicKeyOf(privateKey: KeyObject): Uint8Array {
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const raw = new Uint8Array(spki.subarray(ED25519_SPKI_HEADER_LENGTH));
  if (raw.length !== 32) {
    throw new Error('identity: key is not Ed25519 (public key is not 32 bytes)');
  }
  return raw;
}

export class Identity {
  /** STATED [IDENTITY]: the identifier IS the key. Public, and safe to publish. */
  readonly did: string;

  readonly #privateKey: KeyObject;
  readonly #publicKey: Uint8Array;

  private constructor(privateKey: KeyObject, publicKey: Uint8Array, did: string) {
    this.#privateKey = privateKey;
    this.#publicKey = publicKey;
    this.did = did;
  }

  static #from(privateKey: KeyObject): Identity {
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      // STATED [SIGNING]: "Ed25519 only".
      throw new Error(
        `identity: expected an Ed25519 key, got ${String(privateKey.asymmetricKeyType)}`,
      );
    }
    const publicKey = rawPublicKeyOf(privateKey);
    return new Identity(privateKey, publicKey, didKeyFromPublicKey(publicKey));
  }

  /** Generates a fresh identity. Nothing registers it; there is nowhere to register. */
  static create(): Identity {
    const { privateKey } = generateKeyPairSync('ed25519');
    return Identity.#from(privateKey);
  }

  /**
   * Builds an identity from a raw 32-byte Ed25519 seed.
   *
   * The seed is wrapped into a KeyObject and not retained; this class keeps no
   * copy of the caller's buffer. Provided because published test vectors are
   * expressed as seeds.
   */
  static fromSeed(seed: Uint8Array): Identity {
    if (seed.length !== 32) {
      throw new Error(`identity: an Ed25519 seed is 32 bytes, got ${seed.length}`);
    }
    const der = new Uint8Array(ED25519_PKCS8_HEADER.length + 32);
    der.set(ED25519_PKCS8_HEADER, 0);
    der.set(seed, ED25519_PKCS8_HEADER.length);
    // Only the parse is wrapped. Widening this catch would swallow the
    // Ed25519 check in #from and report every wrong-curve key as a parse
    // failure, which is a different problem with a different fix.
    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey({ key: Buffer.from(der), format: 'der', type: 'pkcs8' });
    } catch {
      // Deliberately not rethrowing the original: its message and stack are
      // built by OpenSSL around the material we just handed it.
      throw new Error('identity: could not build a key from the supplied seed (details withheld)');
    }
    return Identity.#from(privateKey);
  }

  /** Parses an unencrypted PKCS#8 PEM. */
  static fromPem(pem: string): Identity {
    let privateKey: KeyObject;
    try {
      privateKey = createPrivateKey({ key: pem, format: 'pem' });
    } catch {
      throw new Error('identity: could not parse the private key PEM (details withheld)');
    }
    return Identity.#from(privateKey);
  }

  /** Parses an encrypted PKCS#8 PEM, obtaining the passphrase from `provider`. */
  static async fromEncryptedPem(pem: string, provider: PassphraseProvider): Promise<Identity> {
    let privateKey: KeyObject;
    {
      // The passphrase lives only in this block and must not reach a thrown
      // value; the scope is deliberately as small as the parse itself.
      const passphrase = await provider();
      try {
        privateKey = createPrivateKey({ key: pem, format: 'pem', passphrase });
      } catch {
        throw new Error('identity: could not decrypt the private key PEM (details withheld)');
      }
    }
    return Identity.#from(privateKey);
  }

  /**
   * Reads a PEM private key from disk.
   *
   * Pass `provider` only when the file is encrypted. The file's bytes are not
   * logged and do not appear in any error this function throws.
   */
  static async loadPem(path: string, provider?: PassphraseProvider): Promise<Identity> {
    let pem: string;
    try {
      pem = await readFile(path, 'utf8');
    } catch {
      throw new Error(`identity: could not read a private key file at ${path}`);
    }
    return provider === undefined ? Identity.fromPem(pem) : Identity.fromEncryptedPem(pem, provider);
  }

  /** The raw 32-byte Ed25519 PUBLIC key. A fresh copy; the internal one is not exposed. */
  get publicKey(): Uint8Array {
    return Uint8Array.from(this.#publicKey);
  }

  /**
   * Signs an exact payload string and returns the canonical base64url signature.
   *
   * Prefer signMessage / signNote: they build the payload through payload.ts,
   * which sweeps the text first. This lower-level entry point cannot know
   * whether what it was handed was swept.
   */
  sign(payload: string): string {
    // Ed25519 takes no digest algorithm; the first argument must be null.
    const raw = cryptoSign(null, Buffer.from(payload, 'utf8'), this.#privateKey);
    return base64urlEncode(new Uint8Array(raw));
  }

  /**
   * Signs a room message.
   *
   * STATED [SIGNING]: the signature covers `<room>|<nonce>|<text>` over the text
   * AFTER the sweep. The returned `text` is that swept text — send exactly it,
   * not the string you passed in.
   */
  signMessage(room: string, nonce: string, rawText: string): SignedText {
    const signable: Signable = messagePayload(room, nonce, rawText);
    return { did: this.did, nonce, text: signable.text, sig: this.sign(signable.payload) };
  }

  /** Signs a note value; the payload is `<namespace>|<key>|<nonce>|<value>`. */
  signNote(namespace: string, key: string, nonce: string, rawValue: string): SignedText {
    const signable: Signable = notePayload(namespace, key, nonce, rawValue);
    return { did: this.did, nonce, text: signable.text, sig: this.sign(signable.payload) };
  }

  /** Only ever the public identifier. */
  toJSON(): { readonly did: string } {
    return { did: this.did };
  }

  toString(): string {
    return `Identity(${this.did})`;
  }

  [inspect.custom](): string {
    return `Identity(${this.did}) <private key withheld>`;
  }
}
