import { sweep } from './sweep.js';

/**
 * The exact byte strings a signature covers.
 *
 * STATED [SIGNING]: "The signature covers exactly `<room>|<nonce>|<text>` as
 * UTF-8, where <text> is the text AFTER the single-line sweep — the bytes that
 * get stored."
 * STATED [auth.md / agent.json]: a note signature covers
 * `<namespace>|<key>|<nonce>|<value>`, with the same post-sweep rule.
 *
 * Both builders sweep the free-form field themselves and hand back BOTH the
 * payload and the swept text. That is the whole point of this module: there is
 * no supported way to obtain a payload without also obtaining the exact text
 * that must be sent, so "signed one thing, sent another" is unrepresentable.
 *
 * The room name, namespace and key are NOT swept. Only the free-form field is.
 */

/** STATED [SIGNING / openapi]: <nonce> is 1-19 digits. */
export const NONCE_PATTERN = /^[0-9]{1,19}$/;

export interface Signable {
  /** The UTF-8 string to sign. */
  readonly payload: string;
  /** The swept text — send exactly this, not what you passed in. */
  readonly text: string;
}

/**
 * A nonce is carried as digits, never as a number.
 *
 * STATED [EXPORT]: "a stored nonce may be up to 19 digits, which is past 2^53 —
 * parse with a JSON reader that keeps big integers exact, or treat the nonce as
 * opaque digits ... a float-rounded nonce fails good signatures."
 */
function assertNonce(nonce: string): void {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new Error('bad nonce: must be 1-19 digits, carried as a string');
  }
}

function assertNotEmptyAfterSweep(swept: string, field: 'text' | 'value'): void {
  if (swept.length === 0) {
    // STATED [openapi 400]: refused server-side. Failing here costs no request
    // and, on the signed lane, spends no nonce.
    throw new Error(`bad ${field}: empty after the single-line sweep`);
  }
}

export function messagePayload(room: string, nonce: string, rawText: string): Signable {
  assertNonce(nonce);
  const text = sweep(rawText);
  assertNotEmptyAfterSweep(text, 'text');
  return { payload: `${room}|${nonce}|${text}`, text };
}

export function notePayload(namespace: string, key: string, nonce: string, rawValue: string): Signable {
  assertNonce(nonce);
  const text = sweep(rawValue);
  assertNotEmptyAfterSweep(text, 'value');
  return { payload: `${namespace}|${key}|${nonce}|${text}`, text };
}

/**
 * Rebuilds the payload of a record that is ALREADY stored.
 *
 * The stored text has been swept by the server, so it is used verbatim: the
 * server verifies against the bytes it received, and re-sweeping here would
 * quietly paper over a mismatch instead of surfacing it.
 *
 * Never recover a payload by splitting a stored one on '|': the text may
 * contain '|' itself. The format is unambiguous only because the room name and
 * the nonce cannot contain one.
 */
export function storedMessagePayload(room: string, nonce: string, storedText: string): string {
  assertNonce(nonce);
  return `${room}|${nonce}|${storedText}`;
}

export function storedNotePayload(
  namespace: string,
  key: string,
  nonce: string,
  storedValue: string,
): string {
  assertNonce(nonce);
  return `${namespace}|${key}|${nonce}|${storedValue}`;
}
