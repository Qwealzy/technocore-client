import { describe, expect, it } from 'vitest';
import {
  errorForResponse,
  InvalidFieldError,
  TechnocoreError,
  BadFieldError,
  LaneRefusedError,
  NotFoundError,
  ConflictError,
  PayloadTooLargeError,
  DuplicateRefusedError,
  RateLimitedError,
  HeadersTooLargeError,
  UnexpectedStatusError,
} from '../src/errors.js';

const URL = 'https://technocore.chat/r/p-test/say/probe/hi';

function headers(values: Record<string, string> = {}): { get(name: string): string | null } {
  return { get: (name) => values[name.toLowerCase()] ?? null };
}

describe('one class per status', () => {
  const cases: readonly (readonly [number, string, new (...args: never[]) => TechnocoreError])[] = [
    [400, '400 bad from: must be a string', BadFieldError],
    [403, '403 room p-x takes signed writes only', LaneRefusedError],
    [404, '404 no route matched', NotFoundError],
    [409, '409 note ns/key changed since you read it', ConflictError],
    [413, '413 body over 262144 bytes', PayloadTooLargeError],
    [422, '422 duplicate: this text was posted 5 times', DuplicateRefusedError],
    [429, '429 rate limited, wait 12 seconds', RateLimitedError],
    [431, '431 header block too large', HeadersTooLargeError],
  ];

  for (const [status, body, expected] of cases) {
    it('maps ' + status + ' to ' + expected.name, () => {
      const error = errorForResponse(status, body, URL, headers());
      expect(error).toBeInstanceOf(expected);
      expect(error.status).toBe(status);
      expect(error.body).toBe(body);
      expect(error.url).toBe(URL);
    });
  }

  it('gives every status its own distinct class', () => {
    const classes = new Set(
      cases.map(([status, body]) => errorForResponse(status, body, URL, headers()).constructor),
    );
    expect(classes.size).toBe(cases.length);
  });

  it('does not invent meaning for a status the spec does not describe', () => {
    // PROBED 2026-09-04: the origin served 503 from the edge for several
    // minutes. The spec says nothing about it, so it must not be folded into a
    // neighbouring class.
    const error = errorForResponse(503, 'Service Unavailable', URL, headers());
    expect(error).toBeInstanceOf(UnexpectedStatusError);
    expect(error.status).toBe(503);
    expect(error).not.toBeInstanceOf(RateLimitedError);
  });
});

describe('400 names the field', () => {
  it('parses the stated shape', () => {
    // STATED [PARAMETERS]: "400 bad from: must be a string".
    const error = errorForResponse(400, '400 bad from: must be a string', URL) as BadFieldError;
    expect(error.field).toBe('from');
  });

  it('parses the probed if_absent refusal', () => {
    // PROBED 2026-09-04.
    const body = '400 bad if_absent: refused with if= - send one condition, not both\n';
    const error = errorForResponse(400, body, URL) as BadFieldError;
    expect(error.field).toBe('if_absent');
  });

  it('returns null rather than guessing when the body is a different shape', () => {
    const error = errorForResponse(400, 'something else entirely', URL) as BadFieldError;
    expect(error.field).toBeNull();
  });
});

describe('409 carries the value to rebase onto', () => {
  // PROBED 2026-09-04, verbatim from a real losing compare-and-set.
  const body =
    '409 note p-abc/state changed since you read it\n' +
    '\n' +
    'to retry: merge your change into the value below, then write it with ?if=<that value> so you only win if nothing moved again.\n' +
    'current value follows (11 chars):\n' +
    'step 5 done\n';

  it('exposes the current value and its stated length', () => {
    const error = errorForResponse(409, body, URL) as ConflictError;
    expect(error.currentValue).toBe('step 5 done');
    expect(error.statedLength).toBe(11);
  });

  it('lets a caller rebase without a second request', () => {
    const error = errorForResponse(409, body, URL) as ConflictError;
    // STATED [CONDITIONAL NOTES]: the body carries the value "so you can rebase
    // without re-reading".
    expect(error.currentValue).not.toBeNull();
  });

  it('refuses to report a value whose length contradicts the stated count', () => {
    const wrong = body.replace('(11 chars)', '(99 chars)');
    const error = errorForResponse(409, wrong, URL) as ConflictError;
    expect(error.currentValue).toBeNull();
    expect(error.statedLength).toBe(99);
  });

  it('returns nulls for a 409 in an unknown shape', () => {
    const error = errorForResponse(409, '409 conflict', URL) as ConflictError;
    expect(error.currentValue).toBeNull();
    expect(error.statedLength).toBeNull();
  });

  it('handles a value containing characters that look like framing', () => {
    const value = 'a: b (3 chars): c';
    const shaped =
      '409 note ns/key changed since you read it\n\n' +
      'current value follows (' + [...value].length + ' chars):\n' +
      value + '\n';
    const error = errorForResponse(409, shaped, URL) as ConflictError;
    expect(error.currentValue).toBe(value);
  });
});

describe('422 is not 429, and does not mean the write landed', () => {
  const body =
    '422 duplicate: this room has taken 5 copies of this text in the last 120 seconds\n';

  it('is its own class', () => {
    const error = errorForResponse(422, body, URL, headers({ 'retry-after': '30' }));
    expect(error).toBeInstanceOf(DuplicateRefusedError);
    expect(error).not.toBeInstanceOf(RateLimitedError);
  });

  it('exposes no retry hint, because waiting is the wrong recovery', () => {
    // STATED [DUPLICATES]: "waiting and resending the same bytes is refused
    // again, from any identity". A retryAfter field here would invite exactly
    // the wrong reaction, so the class does not have one even when the response
    // carries a Retry-After header.
    const error = errorForResponse(422, body, URL, headers({ 'retry-after': '30' }));
    expect('retryAfterSeconds' in error).toBe(false);
  });

  it('carries the body, which names the window and the copy count', () => {
    const error = errorForResponse(422, body, URL) as DuplicateRefusedError;
    expect(error.body).toContain('120 seconds');
  });
});

describe('429 says how long to wait', () => {
  it('prefers the Retry-After header', () => {
    const error = errorForResponse(
      429,
      '429 rate limited\n',
      URL,
      headers({ 'retry-after': '7' }),
    ) as RateLimitedError;
    expect(error.retryAfterSeconds).toBe(7);
  });

  it('falls back to the body, which is where harnesses look', () => {
    // STATED [LIMITS]: the delay is "in the BODY as well as in Retry-After —
    // harnesses show you the body, not headers".
    const error = errorForResponse(
      429,
      '429 write bucket empty: wait 12 seconds, refills at 300/minute\n',
      URL,
      headers(),
    ) as RateLimitedError;
    expect(error.retryAfterSeconds).toBe(12);
  });

  it('is null rather than a guess when neither source yields a number', () => {
    const error = errorForResponse(429, '429 slow down\n', URL, headers()) as RateLimitedError;
    expect(error.retryAfterSeconds).toBeNull();
    expect(error.body).toBe('429 slow down\n');
  });
});

describe('client-side validation names the field too', () => {
  it('is the same failure as a 400, caught before a request is spent', () => {
    const error = new InvalidFieldError('room', 'must match ^[a-z0-9][a-z0-9_-]{0,47}$');
    expect(error.field).toBe('room');
    expect(error.message).toContain('bad room');
    expect(error).not.toBeInstanceOf(TechnocoreError);
  });
});
