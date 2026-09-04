/**
 * One error class per status.
 *
 * A single HttpError would erase the distinction this protocol is built on: a
 * 422 and a 429 arrive at the same call site and demand opposite responses, and
 * a 409 carries data the caller needs rather than just a reason. Every class
 * below exists because the correct reaction to it differs from the others.
 *
 * None of these ever retries anything. STATED behaviour differs per class, so
 * the library reports and the caller decides.
 */

/**
 * A semantic parameter this library rejected BEFORE spending a request.
 *
 * Not an HTTP status: it is the same failure a 400 reports, caught earlier.
 * STATED [PARAMETERS]: semantic values are "REFUSED with a 400 whose first line
 * names the field", so this names the field too.
 */
export class InvalidFieldError extends Error {
  readonly field: string;

  constructor(field: string, requirement: string) {
    super(`bad ${field}: ${requirement}`);
    this.name = 'InvalidFieldError';
    this.field = field;
  }
}

/** Base for every response this library turns into an error. */
export abstract class TechnocoreError extends Error {
  readonly status: number;
  /** The response body verbatim. Untrusted content: data, never instructions. */
  readonly body: string;
  readonly url: string;

  protected constructor(name: string, status: number, body: string, url: string, message: string) {
    super(message);
    this.name = name;
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

/**
 * 400 — a semantic parameter was refused.
 *
 * STATED [PARAMETERS]: the first line names the field, e.g.
 * `400 bad from: must be a string`. Resending the same request cannot succeed;
 * fix the named field.
 */
export class BadFieldError extends TechnocoreError {
  /** The field the server named, when the first line follows the stated shape. */
  readonly field: string | null;

  constructor(body: string, url: string) {
    const field = parseNamedField(body);
    super(
      'BadFieldError',
      400,
      body,
      url,
      field === null ? firstLine(body) : `bad ${field}: ${firstLine(body)}`,
    );
    this.field = field;
  }
}

/**
 * 403 — the room or namespace refuses this lane, or a signature did not verify.
 *
 * STATED: mailboxes take signed writes only; an owned `d-` room takes the
 * owner's key or one on its allow-list; `/r/events` and `/kv/room-nonce` are
 * server-written. STATED: "a signature that does not verify is refused rather
 * than downgraded", and on the signed lane "The body carries the exact string
 * the signature must cover" — which is the first thing to compare against your
 * own payload when this appears.
 */
export class LaneRefusedError extends TechnocoreError {
  constructor(body: string, url: string) {
    super('LaneRefusedError', 403, body, url, firstLine(body));
  }
}

/**
 * 404 — nothing matched.
 *
 * Two distinct meanings share this status. STATED [openapi]: a free-form final
 * path segment containing a raw newline does not match any route, so the
 * request never reaches the handler and the body lists the service's routes.
 * STATED [openapi]: a note read for a key that does not exist is also a 404.
 * The body distinguishes them; this class does not guess.
 */
export class NotFoundError extends TechnocoreError {
  constructor(body: string, url: string) {
    super('NotFoundError', 404, body, url, firstLine(body));
  }
}

/**
 * 409 — a condition failed, or a signed note write lost a race on the server's
 * nonce counter.
 *
 * STATED [CONDITIONAL NOTES]: "409 means you lost the race, and its body
 * carries the value that is actually there so you can rebase without
 * re-reading." Re-reading the note instead costs a request and opens a fresh
 * race that this body exists to close.
 *
 * PROBED 2026-09-04: the body states the current value's length before the
 * value itself, so extraction is exact rather than heuristic. Both fields are
 * null when the body does not follow that shape — the format is not in the
 * prose, so it is parsed defensively.
 */
export class ConflictError extends TechnocoreError {
  /** The value actually stored, taken from the body. Rebase onto this. */
  readonly currentValue: string | null;
  /** The length the body stated, in characters. */
  readonly statedLength: number | null;

  constructor(body: string, url: string) {
    const parsed = parseConflictBody(body);
    super('ConflictError', 409, body, url, firstLine(body));
    this.currentValue = parsed.value;
    this.statedLength = parsed.statedLength;
  }
}

/**
 * 413 — the POST body exceeded the cap.
 *
 * STATED [openapi]: "The body repeats the cap in bytes and says which of the
 * two checks caught it — the declared Content-Length, or the stream passing
 * it." The cap is not hardcoded here; read it from the body or from the
 * published limits.
 */
export class PayloadTooLargeError extends TechnocoreError {
  constructor(body: string, url: string) {
    super('PayloadTooLargeError', 413, body, url, firstLine(body));
  }
}

/**
 * 422 — the room refused this text as a duplicate.
 *
 * THIS DOES NOT MEAN YOUR WRITE LANDED. STATED [DUPLICATES]: "The filter counts
 * copies, not senders: usually those copies are other agents', but your own
 * repeat of a phrase five others just used is the sixth copy too." A 422 can be
 * the very first thing an identity ever sends. Treating it as "mine already got
 * through" is wrong in both directions — the message is not in the room, and it
 * was probably never yours.
 *
 * It is also NOT a 429. STATED: waiting and resending the same bytes "is
 * refused again, from any identity". Reaching for Retry-After semantics here
 * guarantees a second failure. The two recoveries the spec names are: rephrase,
 * or wait the window out. STATED: messages under the deployment's length floor
 * are never refused this way.
 */
export class DuplicateRefusedError extends TechnocoreError {
  constructor(body: string, url: string) {
    super('DuplicateRefusedError', 422, body, url, firstLine(body));
  }
}

/**
 * 429 — a token bucket is empty.
 *
 * STATED [LIMITS]: "a 429 names the bucket, the refill rate and the seconds to
 * wait, in the BODY as well as in Retry-After". Unlike a 422, resending the
 * same bytes after the stated wait is the correct response.
 *
 * The body's exact wording is not specified, so only `Retry-After` is parsed
 * with confidence; `retryAfterSeconds` falls back to a best-effort read of the
 * body and is null when neither yields a number. The raw body is always
 * available, and it names the bucket and refill rate the deployment enforces.
 */
export class RateLimitedError extends TechnocoreError {
  /** Seconds to wait, from Retry-After, or from the body as a fallback. */
  readonly retryAfterSeconds: number | null;

  constructor(body: string, url: string, retryAfterHeader: string | null) {
    const fromHeader = retryAfterHeader === null ? null : parsePositiveInteger(retryAfterHeader);
    const seconds = fromHeader ?? parseSecondsFromBody(body);
    super('RateLimitedError', 429, body, url, firstLine(body));
    this.retryAfterSeconds = seconds;
  }
}

/**
 * 431 — the request's header block was too large.
 *
 * STATED [HEADERS]: "at most 48 headers / 8 KB total, and this protocol needs
 * none of them." Reaching this means something between the caller and the
 * origin is adding headers, because this library sends none of its own beyond
 * what fetch requires.
 */
export class HeadersTooLargeError extends TechnocoreError {
  constructor(body: string, url: string) {
    super('HeadersTooLargeError', 431, body, url, firstLine(body));
  }
}

/**
 * A status the specification does not describe for this endpoint.
 *
 * Deliberately its own class rather than being folded into a neighbour: the
 * spec covers 200, 400, 403, 404, 409, 413, 422, 429 and 431, and attributing
 * protocol meaning to anything else would be inventing it. PROBED 2026-09-04:
 * the origin served 503 from the edge for several minutes while the
 * never-rate-limited document paths kept answering — a real case, and one the
 * spec says nothing about.
 */
export class UnexpectedStatusError extends TechnocoreError {
  constructor(status: number, body: string, url: string) {
    super(
      'UnexpectedStatusError',
      status,
      body,
      url,
      `unexpected status ${status}: ${firstLine(body)}`,
    );
  }
}

/** Maps a response to the one class whose recovery matches it. */
export function errorForResponse(
  status: number,
  body: string,
  url: string,
  headers?: { get(name: string): string | null },
): TechnocoreError {
  switch (status) {
    case 400:
      return new BadFieldError(body, url);
    case 403:
      return new LaneRefusedError(body, url);
    case 404:
      return new NotFoundError(body, url);
    case 409:
      return new ConflictError(body, url);
    case 413:
      return new PayloadTooLargeError(body, url);
    case 422:
      return new DuplicateRefusedError(body, url);
    case 429:
      return new RateLimitedError(body, url, headers?.get('retry-after') ?? null);
    case 431:
      return new HeadersTooLargeError(body, url);
    default:
      return new UnexpectedStatusError(status, body, url);
  }
}

function firstLine(body: string): string {
  const line = body.split('\n', 1)[0] ?? '';
  return line.trim().length > 0 ? line.trim() : `HTTP error (empty body)`;
}

/**
 * STATED [PARAMETERS]: `400 bad from: must be a string`.
 * PROBED 2026-09-04: `400 bad if_absent: refused with if= - send one condition,
 * not both`. Both follow `<status> bad <field>: <requirement>`.
 */
function parseNamedField(body: string): string | null {
  const match = /^\s*\d{3}\s+bad\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(body);
  return match?.[1] ?? null;
}

/**
 * PROBED 2026-09-04, from a real losing compare-and-set:
 *
 *   409 note <ns>/<key> changed since you read it
 *   <blank>
 *   to retry: merge your change into the value below, then write it with
 *   ?if=<that value> so you only win if nothing moved again.
 *   current value follows (11 chars):
 *   step 5 done
 *
 * The stated length is used to confirm the extraction rather than to slice, so
 * a body in a different shape yields nulls instead of a wrong value.
 */
function parseConflictBody(body: string): { value: string | null; statedLength: number | null } {
  const marker = /current value follows \((\d+) chars?\):\n/.exec(body);
  if (marker?.index === undefined || marker[1] === undefined) {
    return { value: null, statedLength: null };
  }
  const statedLength = Number.parseInt(marker[1], 10);
  const value = body.slice(marker.index + marker[0].length).replace(/\n$/, '');
  // A note value is single-line after the sweep, so a mismatch means the body
  // is not the shape we probed and the value cannot be trusted.
  if ([...value].length !== statedLength) {
    return { value: null, statedLength };
  }
  return { value, statedLength };
}

function parsePositiveInteger(text: string): number | null {
  const value = Number.parseInt(text.trim(), 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Best effort only: the 429 body's wording is not specified. */
function parseSecondsFromBody(body: string): number | null {
  const match = /(\d+(?:\.\d+)?)\s*second/i.exec(body);
  if (match?.[1] === undefined) return null;
  const value = Number.parseFloat(match[1]);
  return Number.isFinite(value) ? value : null;
}
