import { Identity } from './identity.js';
import { errorForResponse, InvalidFieldError, type TechnocoreError } from './errors.js';
import { roomName, type RoomName, type Nick } from './names.js';
import { sweep } from './sweep.js';
import { NONCE_PATTERN } from './payload.js';
import { DID_KEY_PATTERN } from './did.js';
import { SIGNATURE_PATTERN } from './encoding.js';

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
 * This is the one number in this package that is not read at runtime, because
 * there is nowhere to read it from: it is a property of whatever CDN or proxy
 * sits in front of an instance, and no endpoint publishes it — it is absent
 * from /config and from /.well-known/agent.json, both of which carry only the
 * knobs the application itself enforces. The spec states it as approximate.
 * Override it with `maxUrlBytes` when you know your deployment's real ceiling.
 */
export const SPEC_STATED_URL_BUDGET_BYTES = 16384;

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
}

export type Lane = 'get' | 'post';

export interface LaneDecision {
  readonly lane: Lane;
  /** The GET URL that was measured — sent as-is when the lane is 'get'. */
  readonly url: string;
  /** Its length in UTF-8 bytes. This is the quantity the budget applies to. */
  readonly urlBytes: number;
  readonly maxUrlBytes: number;
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
  readonly maxUrlBytes: number;
  readonly #fetch: FetchLike;

  constructor(options: TransportOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.maxUrlBytes = options.maxUrlBytes ?? SPEC_STATED_URL_BUDGET_BYTES;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
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
    return {
      lane: urlBytes <= this.maxUrlBytes ? 'get' : 'post',
      url,
      urlBytes,
      maxUrlBytes: this.maxUrlBytes,
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
        ? await this.#json(decision.url)
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
   * Minimal on purpose: cursor semantics, gap detection and long-polling arrive
   * with the reads increment. `limit` is advisory — STATED [PARAMETERS]: it is
   * clamped and never refused, so read `count` off the reply rather than
   * assuming the value you sent survived.
   */
  async readRoomPage(room: string, options: { readonly limit?: number } = {}): Promise<RoomPage> {
    const name = roomName(room);
    const query = new URLSearchParams({ format: 'json' });
    // An absent advisory parameter is omitted rather than sent empty.
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    return this.#json(`${this.baseUrl}/r/${name}?${query.toString()}`);
  }

  async #json(url: string, init?: Parameters<FetchLike>[1]): Promise<RoomPage> {
    const response = await this.#fetch(url, init);
    const body = await response.text();
    if (response.status !== 200) {
      throw errorForResponse(response.status, body, url, response.headers);
    }
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
