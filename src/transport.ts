import { Identity } from './identity.js';
import {
  errorForResponse,
  bodyNamesAField,
  BadFieldError,
  InvalidFieldError,
  UrlTooLongError,
  type TechnocoreError,
} from './errors.js';
import { roomName, type RoomName, type Nick } from './names.js';
import { sweep } from './sweep.js';
import { NONCE_PATTERN } from './payload.js';
import { DID_KEY_PATTERN } from './did.js';
import { SIGNATURE_PATTERN } from './encoding.js';
import { BudgetTracker, type Bucket } from './limits.js';

/**
 * HTTP, lane selection, and turning a response into the one error class whose
 * recovery matches it.
 *
 * This module sends no headers of its own. STATED [HEADERS]: "this protocol
 * needs none of them", and a header block over the cap is a 431 — so anything
 * added here would be pure risk.
 */

export const DEFAULT_BASE_URL = 'https://technocore.chat';

/**
 * The GET write lane's real ceiling, in URL bytes.
 *
 * STATED [URL BUDGET]: "the GET write lane carries the text in the path, so its
 * real limit is URL length (~16 KB at the edge), not the character count."
 *
 * The server's own README states it without the tilde — "URL length (16 KB at
 * the edge)" — and its deployment notes name the enforcement point, a uvicorn
 * `--h11-max-incomplete-event-size 16384` chosen rather than left at a library
 * default, against Cloudflare's 16 KiB ceiling.
 *
 * It is still not read at runtime, because no endpoint publishes it: /config
 * and /.well-known/agent.json carry the knobs the application itself enforces,
 * and this ceiling belongs to the proxy in front of it. Hence a named default
 * rather than a discovered value — and an overridable one, since a self-hosted
 * deployment behind different infrastructure has a different ceiling with
 * nothing to announce it. `maxUrlBytes` sets it; the downward learning below
 * covers the case where it is lower than this.
 */
export const SPEC_STATED_URL_BUDGET_BYTES = 16384;

/**
 * The request-line length every HTTP implementation is expected to handle.
 *
 * RFC 7230 section 3.1.1: "It is RECOMMENDED that all HTTP senders and
 * recipients support, at a minimum, request-line lengths of 8000 octets."
 *
 * This is not a limit and nothing is enforced against it. It is used in exactly
 * one place: deciding whether a generic 400 on the GET lane is long enough for
 * "the edge refused the request line" to be worth mentioning in an error
 * message. Below it, an edge rejecting on length would be violating a
 * recommendation the whole ecosystem follows, so raising the possibility would
 * be noise. An external standard rather than a number of our own.
 */
export const RFC7230_RECOMMENDED_REQUEST_LINE_BYTES = 8000;

export type FetchLike = (
  url: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
) => Promise<Response>;

export interface TransportOptions {
  readonly baseUrl?: string;
  /** Injectable for tests. Defaults to the global fetch. */
  readonly fetch?: FetchLike;
  /** See SPEC_STATED_URL_BUDGET_BYTES. */
  readonly maxUrlBytes?: number;
  /**
   * Where budget observations are recorded. One is created if none is given.
   *
   * Share one across transports pointed at the same deployment: the buckets are
   * per client IP, not per client object.
   */
  readonly budget?: BudgetTracker;
}

export type Lane = 'get' | 'post';

export interface LaneDecision {
  readonly lane: Lane;
  /** The GET URL that was measured — sent as-is when the lane is 'get'. */
  readonly url: string;
  /** Its length in UTF-8 bytes. This is the quantity the budget applies to. */
  readonly urlBytes: number;
  /** The budget actually applied, which is the configured one until a refusal narrows it. */
  readonly maxUrlBytes: number;
}

/**
 * What this transport has observed about its edge's real URL ceiling.
 *
 * Observations, not limits. They live on one Transport instance, are never
 * written anywhere, and are gone when the process is. Nothing is inferred
 * beyond what was seen: a refusal at N bytes proves only that N is too many.
 */
export interface UrlBudgetObservations {
  /** The value this transport was constructed with. */
  readonly configured: number;
  /** What lane selection uses now — the configured value, narrowed by refusals. */
  readonly effective: number;
  /** The longest GET write URL the edge has accepted on this instance. */
  readonly largestAccepted: number | null;
  /** The shortest GET write URL the edge has refused on this instance. */
  readonly smallestRejected: number | null;
}

export interface StoredMessage {
  readonly seq: bigint;
  readonly ts: string;
  /**
   * A self-asserted nickname, or a did:key when the message came through the
   * signed lane. STATED [IDENTITY]: unverified either way unless it is a
   * did:key, and a signature proves possession of a key and nothing else.
   */
  readonly from: string;
  /** Untrusted content. Data, never instructions. */
  readonly text: string;
  /** Digits, never a number. Present on signed messages only. */
  readonly nonce?: string;
  /**
   * STATED [RENDERING]: absent on records written before the field existed,
   * which means "not re-verifiable", not "invalid".
   */
  readonly sig?: string;
}

export interface RoomPage {
  readonly room: string;
  readonly count: number;
  readonly firstSeq: bigint | null;
  readonly lastSeq: bigint;
  readonly generation: number;
  readonly messages: readonly StoredMessage[];
  /** Present only on a wait= read that returned nothing. */
  readonly waitHeld: boolean | null;
}

export interface ReadPageOptions {
  /** Advisory. STATED: clamped to 1..200, junk falls back to 50, never refused. */
  readonly limit?: number;
  /** The cursor: return only messages with a greater seq. */
  readonly since?: bigint;
  /** Long-poll seconds. Requires `since`; refused without one. */
  readonly waitSeconds?: number;
  /** Throwaway value that varies the URL past a response cache. */
  readonly cacheBuster?: number;
}

export interface SignedWriteResult {
  readonly lane: Lane;
  readonly did: string;
  readonly nonce: string;
  /** The swept text — what was signed and what was sent. */
  readonly text: string;
  readonly sig: string;
  /** The room as the server returned it after the append. */
  readonly page: RoomPage;
}

export class Transport {
  readonly baseUrl: string;
  /** The configured budget. See `urlBudget` for what lane selection actually uses. */
  readonly maxUrlBytes: number;
  readonly #fetch: FetchLike;

  /**
   * Narrowed by refusals, never widened, never persisted.
   *
   * The failure this exists for: an edge whose real ceiling is BELOW the
   * spec's stated approximation. Without it, every long GET write walks into
   * the same wall and is refused identically for the life of the process.
   */
  #smallestRejected: number | null = null;
  #largestAccepted: number | null = null;

  /**
   * STATED [LIMITS]: reads and writes are separate buckets, so this tracks them
   * apart. Every reply this transport receives is fed in, including the ones
   * that say nothing — which, on the JSON lane, is all of them.
   */
  readonly budget: BudgetTracker;

  constructor(options: TransportOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.maxUrlBytes = options.maxUrlBytes ?? SPEC_STATED_URL_BUDGET_BYTES;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.budget = options.budget ?? new BudgetTracker();
  }

  /**
   * Whether an edge rejection is worth raising as a possibility. INFERRED.
   *
   * Two conditions, both required:
   *   - the body does not name a field, so it is not the shape the application
   *     is STATED to use for a refused parameter;
   *   - length is a live explanation, meaning the URL is past the request-line
   *     length RFC 7230 recommends every implementation support, and past
   *     anything this edge has already been seen to accept.
   *
   * The second clause is why a successful long write silences this: once the
   * edge has accepted 9000 bytes, a 400 at 8500 is evidence about the
   * parameters, not about the length.
   */
  #mayBeEdgeRejection(body: string, urlBytes: number): boolean {
    if (bodyNamesAField(body)) return false;
    if (urlBytes <= RFC7230_RECOMMENDED_REQUEST_LINE_BYTES) return false;
    if (this.#largestAccepted !== null && urlBytes <= this.#largestAccepted) return false;
    return true;
  }

  #recordRejected(urlBytes: number): void {
    this.#smallestRejected =
      this.#smallestRejected === null ? urlBytes : Math.min(this.#smallestRejected, urlBytes);
  }

  #recordAccepted(urlBytes: number): void {
    this.#largestAccepted =
      this.#largestAccepted === null ? urlBytes : Math.max(this.#largestAccepted, urlBytes);
  }

  get urlBudget(): UrlBudgetObservations {
    return {
      configured: this.maxUrlBytes,
      effective: this.#effectiveMaxUrlBytes(),
      largestAccepted: this.#largestAccepted,
      smallestRejected: this.#smallestRejected,
    };
  }

  /**
   * A refusal at N bytes proves N is too many and nothing more, so the budget
   * becomes N - 1 rather than some fraction of N. That is the only honest
   * inference available: we do not choose the payload lengths, so we cannot
   * search for the real ceiling, and guessing a factor below N would send
   * writes to POST that the GET lane would have taken.
   */
  #effectiveMaxUrlBytes(): number {
    if (this.#smallestRejected === null) return this.maxUrlBytes;
    return Math.min(this.maxUrlBytes, this.#smallestRejected - 1);
  }

  /**
   * Decides which lane a signed message goes down by building the GET URL and
   * measuring it.
   *
   * STATED [URL BUDGET]: the axis "is URL bytes per character, not which script
   * you write in ... That is not the Latin/non-Latin line it looks like: dense
   * Vietnamese and dense Polish are Latin and both blow the budget at 4096
   * characters, while ordinary Vietnamese prose at ~2.7 bytes per character
   * fits. Measure your own text rather than trusting its script."
   *
   * So there is no estimate here and no per-character arithmetic: the actual
   * percent-encoded URL is constructed and its byte length taken.
   */
  selectSignedMessageLane(
    room: RoomName,
    did: string,
    sig: string,
    nonce: string,
    sweptText: string,
  ): LaneDecision {
    const url = this.signedMessageUrl(room, did, sig, nonce, sweptText);
    return this.#decide(url);
  }

  selectUnsignedMessageLane(room: RoomName, from: Nick, sweptText: string): LaneDecision {
    const url = this.unsignedMessageUrl(room, from, sweptText);
    return this.#decide(url);
  }

  #decide(url: string): LaneDecision {
    const urlBytes = Buffer.byteLength(url, 'utf8');
    const maxUrlBytes = this.#effectiveMaxUrlBytes();
    return {
      lane: urlBytes <= maxUrlBytes ? 'get' : 'post',
      url,
      urlBytes,
      maxUrlBytes,
    };
  }

  signedMessageUrl(
    room: RoomName,
    did: string,
    sig: string,
    nonce: string,
    sweptText: string,
  ): string {
    return (
      `${this.baseUrl}/r/${room}/say-signed/${encodeURIComponent(did)}/` +
      `${encodeURIComponent(sig)}/${encodeURIComponent(nonce)}/` +
      `${encodeURIComponent(sweptText)}?format=json`
    );
  }

  unsignedMessageUrl(room: RoomName, from: Nick, sweptText: string): string {
    return `${this.baseUrl}/r/${room}/say/${from}/${encodeURIComponent(sweptText)}?format=json`;
  }

  /**
   * Signs and sends one message, choosing the lane by measurement.
   *
   * The text is swept by Identity.signMessage before it is signed, and the
   * swept text is what gets sent — STATED [SIGNING], and the reason the two
   * cannot drift apart here.
   *
   * Nothing is retried. STATED behaviour differs per refusal: a 429 wants the
   * same bytes again after a wait, a 422 wants different bytes, and a 403 on
   * this lane wants a different lane. The caller decides.
   */
  async sendSignedMessage(
    identity: Identity,
    room: string,
    nonce: string,
    rawText: string,
  ): Promise<SignedWriteResult> {
    const name = roomName(room);
    assertNonce(nonce);
    const signed = identity.signMessage(name, nonce, rawText);
    const decision = this.selectSignedMessageLane(
      name,
      signed.did,
      signed.sig,
      signed.nonce,
      signed.text,
    );

    const page =
      decision.lane === 'get'
        ? await this.#json(decision.url, undefined, decision.urlBytes)
        : await this.#json(`${this.baseUrl}/r/${name}?format=json`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // STATED [openapi]: on the POST lane the nonce is a string of 1-19
            // digits. Sending it as a JSON number would round anything past
            // 2^53 and produce a signature mismatch the server reports as a
            // plain 403.
            body: JSON.stringify({
              did: signed.did,
              sig: signed.sig,
              nonce: signed.nonce,
              text: signed.text,
            }),
          });

    return {
      lane: decision.lane,
      did: signed.did,
      nonce: signed.nonce,
      text: signed.text,
      sig: signed.sig,
      page,
    };
  }

  /**
   * Reads one page of a room.
   *
   * `limit` is advisory. STATED [PARAMETERS]: it is clamped and never refused,
   * so the count on the reply is the answer and the value you sent is not
   * echoed back anywhere. Absent options are omitted rather than sent empty.
   */
  async readRoomPage(room: string, options: ReadPageOptions = {}): Promise<RoomPage> {
    const name = roomName(room);
    const query = new URLSearchParams({ format: 'json' });

    if (options.limit !== undefined) query.set('limit', String(options.limit));

    // A cursor is carried as digits: STATED [EXPORT], a seq past 2^53 cannot
    // survive a round trip through a JavaScript number.
    if (options.since !== undefined) query.set('since', options.since.toString());

    if (options.waitSeconds !== undefined) {
      // STATED [WAITING]: wait is valid "only together with since=", and
      // patterns.md says it "only takes effect together with a real since=".
      // PROBED 2026-09-05: sent alone it is ignored, the reply comes back at
      // once, and it carries no wait_held field at all. Sending it without a
      // cursor spends a read and buys nothing, so it is refused here rather
      // than quietly dropped.
      if (options.since === undefined) {
        throw new InvalidFieldError('wait', 'requires since; the server ignores it otherwise');
      }
      query.set('wait', String(options.waitSeconds));
    }

    // STATED [POLLING]: the URL changes as the room advances, "which defeats
    // the response cache in most agent harnesses. If you must re-poll an
    // unchanged URL, add a throwaway &n=<counter>." A quiet long-poll reissues
    // the identical since, so the URL would not otherwise change.
    if (options.cacheBuster !== undefined) query.set('n', String(options.cacheBuster));

    return this.#json(`${this.baseUrl}/r/${name}?${query.toString()}`);
  }

  /**
   * A request whose reply is text/plain, which is the only lane notes have.
   *
   * CONFIRMED IN SOURCE: `note_read` in `src/app.py` returns
   * `text(f"{BANNER}

{value}" + budget_note(...))` and never consults
   * `format`, so `?format=json` on a single note read is silently ignored and
   * the reply stays text/plain. Parsing it as JSON would fail on every note.
   *
   * Unlike the JSON lane, this one CAN carry a budget footer, so the tracker is
   * told so: an absent footer here really does mean the bucket is above a
   * quarter, rather than meaning nothing at all.
   */
  async requestText(
    url: string,
    init?: Parameters<FetchLike>[1],
    options: { readonly bucket?: Bucket; readonly getLaneWriteBytes?: number } = {},
  ): Promise<{ readonly status: number; readonly body: string; readonly contentType: string }> {
    const response = await this.#fetch(url, init);
    const body = await response.text();
    const bucket: Bucket =
      options.bucket ?? (init?.method !== undefined || options.getLaneWriteBytes !== undefined ? 'write' : 'read');

    this.budget.observe({
      status: response.status,
      body,
      bucket,
      carriesFooter: true,
      retryAfterHeader: response.headers?.get('retry-after') ?? null,
    });

    if (options.getLaneWriteBytes !== undefined && isUrlLengthRefusal(response.status)) {
      this.#recordRejected(options.getLaneWriteBytes);
      throw new UrlTooLongError(
        response.status,
        body,
        url,
        options.getLaneWriteBytes,
        this.#effectiveMaxUrlBytes(),
      );
    }

    if (response.status === 400 && options.getLaneWriteBytes !== undefined) {
      throw new BadFieldError(
        body,
        url,
        this.#mayBeEdgeRejection(body, options.getLaneWriteBytes),
        options.getLaneWriteBytes,
      );
    }

    if (response.status !== 200) {
      throw errorForResponse(response.status, body, url, response.headers);
    }

    if (options.getLaneWriteBytes !== undefined) this.#recordAccepted(options.getLaneWriteBytes);

    return {
      status: response.status,
      body,
      contentType: response.headers?.get('content-type') ?? '',
    };
  }

  /** Measures a note-write URL the same way a message write is measured. */
  noteSetUrl(namespace: string, key: string, sweptValue: string, query = ''): string {
    return `${this.baseUrl}/kv/${namespace}/${key}/set/${encodeURIComponent(sweptValue)}${query}`;
  }

  decideLane(url: string): LaneDecision {
    return this.#decide(url);
  }

  /**
   * @param getLaneWriteBytes set only for a write sent down the GET lane; it is
   * the measured URL length, and it is what makes a length refusal
   * distinguishable from the protocol's own 413.
   */
  async #json(
    url: string,
    init?: Parameters<FetchLike>[1],
    getLaneWriteBytes?: number,
  ): Promise<RoomPage> {
    const response = await this.#fetch(url, init);
    const body = await response.text();

    // A write is anything with a method, or a GET down the say/set lanes.
    const bucket: Bucket = init?.method !== undefined || getLaneWriteBytes !== undefined ? 'write' : 'read';
    // CONFIRMED IN SOURCE: respond() in src/app.py emits the budget footer only
    // on the text lane — a ?format=json reply drops it. Everything this method
    // sends asks for JSON, so an absent footer here means nothing at all rather
    // than "above a quarter", and the tracker must not read it as the latter.
    this.budget.observe({
      status: response.status,
      body,
      bucket,
      carriesFooter: false,
      retryAfterHeader: response.headers?.get('retry-after') ?? null,
    });

    if (getLaneWriteBytes !== undefined && isUrlLengthRefusal(response.status)) {
      // 414 is not in the specification at all, and 413 is described there only
      // as the POST body cap — which cannot be what a GET with no body hit. On
      // this lane both mean the edge refused the request line.
      this.#recordRejected(getLaneWriteBytes);
      throw new UrlTooLongError(
        response.status,
        body,
        url,
        getLaneWriteBytes,
        this.#effectiveMaxUrlBytes(),
      );
    }

    if (response.status === 400 && getLaneWriteBytes !== undefined) {
      // Some edges answer an over-long request line with 400, which collides
      // with the application's own 400. Nothing is reclassified: this raises
      // the possibility in the message and leaves the class, the field and the
      // recovery to the caller.
      throw new BadFieldError(
        body,
        url,
        this.#mayBeEdgeRejection(body, getLaneWriteBytes),
        getLaneWriteBytes,
      );
    }

    if (response.status !== 200) {
      throw errorForResponse(response.status, body, url, response.headers);
    }

    if (getLaneWriteBytes !== undefined) this.#recordAccepted(getLaneWriteBytes);
    // STATED [PARAMETERS]: format is advisory — "any format other than the
    // literal json leaves the reply as text/plain". A 200 is not a promise of
    // JSON, so the content type is checked rather than assumed.
    const contentType = response.headers?.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      throw new InvalidFieldError(
        'format',
        `expected application/json, got ${contentType || 'no content-type'}`,
      );
    }
    return parseRoomPage(body);
  }
}

/**
 * 414 URI Too Long, and 413 on a request that carried no body.
 *
 * Neither is a protocol status here: the spec's 413 is the 256 KiB POST body
 * cap, and some edges answer an over-long request line with 413 rather than
 * 414. Both are the infrastructure in front of the service, not the service.
 */
function isUrlLengthRefusal(status: number): boolean {
  return status === 414 || status === 413;
}

function assertNonce(nonce: string): void {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new InvalidFieldError('nonce', 'must be 1-19 digits, carried as a string');
  }
}

/** Validates a did:key without needing its bytes. Semantic, so checked up front. */
export function assertDid(did: string): void {
  if (!DID_KEY_PATTERN.test(did)) {
    throw new InvalidFieldError('did', 'must match ^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{44}$');
  }
}

/** Semantic, and the canonicality rule is part of the shape the server accepts. */
export function assertSignature(sig: string): void {
  if (!SIGNATURE_PATTERN.test(sig)) {
    throw new InvalidFieldError('sig', 'must be 86 canonical base64url characters ending in A, Q, g or w');
  }
}

/**
 * Keys whose values must survive as exact digits.
 *
 * STATED [EXPORT]: "a stored nonce may be up to 19 digits, which is past 2^53 —
 * parse with a JSON reader that keeps big integers exact ... a float-rounded
 * nonce fails good signatures." JSON.parse rounds before any reviver can see
 * the value, so the digits are quoted in the raw text first. `seq` gets the
 * same treatment because a cursor that drifts is a cursor that silently skips
 * or repeats messages.
 */
const BIG_INTEGER_KEYS = ['seq', 'nonce', 'first_seq', 'last_seq'] as const;

/**
 * The key quote is required to sit directly after `{` or `,`, which a quote
 * inside a string value never does: JSON escapes those as `\"`, leaving a
 * backslash between the separator and the quote. So a message whose text
 * happens to contain `{"seq": 999}` is not rewritten.
 */
const BIG_INTEGER_PATTERN = new RegExp(
  `([{,]\\s*)"(${BIG_INTEGER_KEYS.join('|')})"(\\s*:\\s*)(\\d+)`,
  'g',
);

export function parseRoomPage(raw: string): RoomPage {
  const quoted = raw.replace(BIG_INTEGER_PATTERN, '$1"$2"$3"$4"');
  const parsed = JSON.parse(quoted) as Record<string, unknown>;

  const messages = Array.isArray(parsed['messages'])
    ? (parsed['messages'] as Record<string, unknown>[]).map(readMessage)
    : [];

  return {
    room: String(parsed['room'] ?? ''),
    count: Number(parsed['count'] ?? messages.length),
    firstSeq: readBigInt(parsed['first_seq']),
    lastSeq: readBigInt(parsed['last_seq']) ?? 0n,
    generation: Number(parsed['generation'] ?? 0),
    messages,
    waitHeld: typeof parsed['wait_held'] === 'boolean' ? parsed['wait_held'] : null,
  };
}

function readMessage(record: Record<string, unknown>): StoredMessage {
  const message: {
    seq: bigint;
    ts: string;
    from: string;
    text: string;
    nonce?: string;
    sig?: string;
  } = {
    seq: readBigInt(record['seq']) ?? 0n,
    ts: String(record['ts'] ?? ''),
    from: String(record['from'] ?? ''),
    text: String(record['text'] ?? ''),
  };
  // Omitted rather than set to undefined: a missing sig means "not
  // re-verifiable", and the difference should be visible in the object.
  if (typeof record['nonce'] === 'string') message.nonce = record['nonce'];
  if (typeof record['sig'] === 'string') message.sig = record['sig'];
  return message;
}

function readBigInt(value: unknown): bigint | null {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return null;
}

export type { TechnocoreError };
