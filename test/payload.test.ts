import { describe, expect, it } from 'vitest';
import {
  messagePayload,
  notePayload,
  storedMessagePayload,
  storedNotePayload,
  NONCE_PATTERN,
} from '../src/payload.js';

describe('message payload', () => {
  it('is room, nonce and swept text joined by a pipe', () => {
    // STATED [SIGNING]: the signature covers exactly <room>|<nonce>|<text>.
    expect(messagePayload('lobby', '7', 'hello').payload).toBe('lobby|7|hello');
  });

  it('signs the swept text and hands back the same swept text to send', () => {
    // The trap this API exists to close: signing the raw input produces a
    // signature over bytes the server never stores.
    const signable = messagePayload('lobby', '7', '  hel\u0000lo  ');
    expect(signable.text).toBe('hel lo');
    expect(signable.payload).toBe('lobby|7|hel lo');
    expect(signable.payload.endsWith(signable.text)).toBe(true);
  });

  it('does not sweep the room name', () => {
    // Only the free-form field is swept; the room name is used verbatim.
    expect(messagePayload('e-commerce', '1', 'x').payload).toBe('e-commerce|1|x');
  });

  it('keeps a pipe inside the text, which is why verification must not split', () => {
    const signable = messagePayload('lobby', '9', 'a|b|c');
    expect(signable.payload).toBe('lobby|9|a|b|c');
    // Splitting this back apart would give the wrong text.
    expect(signable.payload.split('|')).toHaveLength(5);
  });
});

describe('note payload', () => {
  it('is namespace, key, nonce and swept value joined by pipes', () => {
    // STATED [auth.md / agent.json]: <namespace>|<key>|<nonce>|<value>.
    expect(notePayload('room-owners', 'd-jobs', '3', 'did:key:zAbc').payload).toBe(
      'room-owners|d-jobs|3|did:key:zAbc',
    );
  });

  it('sweeps the value', () => {
    const signable = notePayload('room-allow', 'd-jobs', '4', ' a\u2028b ');
    expect(signable.text).toBe('a b');
    expect(signable.payload).toBe('room-allow|d-jobs|4|a b');
  });
});

describe('nonce handling', () => {
  it('accepts 1 to 19 digits', () => {
    expect(NONCE_PATTERN.test('1')).toBe(true);
    expect(NONCE_PATTERN.test('9'.repeat(19))).toBe(true);
    expect(NONCE_PATTERN.test('9'.repeat(20))).toBe(false);
    expect(NONCE_PATTERN.test('')).toBe(false);
  });

  it('refuses anything that is not digits, rather than coercing', () => {
    // STATED [PARAMETERS]: semantic fields are refused, never type-coerced.
    for (const bad of ['', '-1', '1.0', '1e3', ' 1', '1 ', 'abc', '9'.repeat(20)]) {
      expect(() => messagePayload('lobby', bad, 'hi')).toThrow(/1-19 digits/);
    }
  });

  it('preserves a 19-digit nonce exactly, past 2^53', () => {
    // STATED [EXPORT]: a float-rounded nonce fails good signatures.
    const nonce = '9223372036854775807';
    expect(Number(nonce).toString()).not.toBe(nonce);
    expect(messagePayload('lobby', nonce, 'hi').payload).toBe('lobby|' + nonce + '|hi');
  });
});

describe('empty after sweep', () => {
  it('refuses a text that sweeps to nothing, before spending a request', () => {
    // STATED [openapi 400]. On the signed lane this also avoids spending a
    // nonce on a write that cannot land.
    const twoJoiners = String.fromCharCode(0x200d, 0x200d);
    expect(() => messagePayload('lobby', '1', twoJoiners)).toThrow(
      /empty after the single-line sweep/,
    );
    expect(() => notePayload('ns', 'k', '1', '   ')).toThrow(/empty after the single-line sweep/);
  });
});

describe('stored payloads (verification side)', () => {
  it('uses the stored text verbatim rather than sweeping it again', () => {
    // The server verifies against the bytes it received. Re-sweeping here would
    // paper over a mismatch instead of surfacing it.
    expect(storedMessagePayload('lobby', '7', 'a  b')).toBe('lobby|7|a  b');
    expect(storedNotePayload('ns', 'k', '7', 'a  b')).toBe('ns|k|7|a  b');
  });

  it('agrees with the signing side for text that was swept before signing', () => {
    const signable = messagePayload('lobby', '7', ' he\u0000llo ');
    expect(storedMessagePayload('lobby', '7', signable.text)).toBe(signable.payload);
  });
});
