import { InvalidFieldError } from './errors.js';

/**
 * Runtime limit discovery, and what a response tells you about your budget.
 *
 * WHY NOTHING HERE IS A CONSTANT
 *
 * technocore.chat enforces 600 reads and 300 writes per minute. The server's
 * own documented defaults are 120 and 30. Both numbers are correct, and only
 * one of them is what the deployment does — so a client that hardcoded the
 * published defaults, which is the reasonable thing to do, would pace itself to
 * a fifth of its read budget and a tenth of its write budget. Nothing would say
 * so: no error, no warning, no slow path. Just an agent quieter than it needed
 * to be for as long as it runs.
 *
 * That is the whole argument, and it is stronger than the principle. STATED
 * [LIMITS], the manual takes the same position from the other side: it names no
 * numbers because "a manual that states a limit the server does not enforce is
 * worse than one that states none, because you would pace yourself to it."
 *
 * STATED [LIMITS]: the documents are never rate limited — `/`, `/llms.txt`,
 * `/skill.md`, `/patterns.md`, `/interop.md`, `/auth.md`, `/openapi.json`,
 * `/config`, `/.well-known/*` and `/healthz`. Discovery therefore works while
 * you are throttled, which is exactly when you need it.
 */

/** STATED [LIMITS]: reads and writes are separate buckets. */
export type Bucket = 'read' | 'write';

/**
 * What a single response revealed about a bucket.
 *
 * The distinction this type exists for: **an absent budget footer is not a full
 * bucket.** STATED [LIMITS], the footer appears only "once you drop below a
 * quarter of the bucket", so its absence carries information only when the
 * response was one that could have carried it — and none at all otherwise.
 *
 * Collapsing `unknown` into `aboveQuarter` would let a client conclude it has
 * room on the strength of a reply that never had anywhere to put the number.
 */
export type BudgetReading =
  | {
      /**
       * The response could not carry a footer, so it said nothing.
       *
       * CONFIRMED IN SOURCE: `respond()` in `src/app.py` emits the footer only
       * on the text lane — a `?format=json` reply drops it. This client asks
       * for JSON everywhere it can, so most of its traffic lands here.
       * `/export` likewise streams with no footer.
       */
      readonly state: 'unknown';
    }
  | {
      /**
       * A response that would have carried a footer did not, so the bucket is
       * above a quarter. A bound, not a measurement.
       */
      readonly state: 'above-quarter';
      readonly bucket: Bucket;
      readonly observedAt: Date;
    }
  | {
      /** The footer was present and gives exact figures. */
      readonly state: 'reported';
      readonly bucket: Bucket;
      readonly left: number;
      readonly max: number;
      readonly observedAt: Date;
    }
  | {
      /** A 429. The bucket is spent and the body says how long to wait. */
      readonly state: 'exhausted';
      readonly bucket: Bucket;
      readonly max: number;
      readonly retryAfterSeconds: number;
      readonly observedAt: Date;
    };

/**
 * The threshold below which the server starts appending a footer.
 *
 * CONFIRMED IN SOURCE, `src/limit.py`: `if left * 4 > per_min: return ""`. This
 * is a protocol behaviour rather than a deployment knob — it takes no
 * environment variable and appears in no published document — so it is named
 * here with its source rather than read at runtime. It is used only to describe
 * what an absent footer implies, never to decide anything.
 */
export const BUDGET_FOOTER_FRACTION = 4;

export interface PublishedLimits {
  /** STATED: limits.reads_per_minute_per_ip. */
  readonly readsPerMinutePerIp: number;
  /** STATED: limits.writes_per_minute_per_ip. */
  readonly writesPerMinutePerIp: number;
  /**
   * STATED by `/config` and `/.well-known/agent.json`, and by the server's
   * `CHAT_RATE_ROOMS_PER_DAY`. Not a token bucket — the prose's "two token
   * buckets" is accurate about token buckets, and this is a daily counter
   * alongside them.
   *
   * **The spec does not describe what happens when it is hit**: no status, no
   * body shape, no statement that it is enforced at the edge or the origin. So
   * this client reports the number and has no special handling for a failure
   * mode nothing documents.
   */
  readonly newRoomsPerDayPerIp: number | null;
  /** STATED: limits.long_poll_seconds — the ceiling `wait=` is clamped to. */
  readonly longPollSeconds: number | null;
  readonly messageChars: number | null;
  readonly noteChars: number | null;
  readonly ephemeralTtlSeconds: number | null;
  readonly duplicateFilterSeconds: number | null;
  /** Which document these came from, and when. */
  readonly source: 'agent.json' | 'config';
  readonly fetchedAt: Date;
}

type FetchLike = (url: string) => Promise<Response>;

function readNumber(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function required(value: number | null, key: string): number {
  if (value === null) {
    throw new InvalidFieldError(key, 'missing or not a number in the published limits');
  }
  return value;
}

/**
 * Reads the limits this deployment actually enforces.
 *
 * `/.well-known/agent.json` is the document registries read and carries the
 * two rate limits up front; `/config` carries those plus every other knob, each
 * keyed by the environment variable that moves it. Both are outside the rate
 * limiter, so this works while throttled.
 */
export async function discoverLimits(
  options: { readonly baseUrl?: string; readonly fetch?: FetchLike } = {},
): Promise<PublishedLimits> {
  const baseUrl = (options.baseUrl ?? 'https://technocore.chat').replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((url: string) => fetch(url));

  const response = await doFetch(`${baseUrl}/.well-known/agent.json`);
  if (response.status !== 200) {
    throw new InvalidFieldError(
      'agent.json',
      `expected 200 from the published limits, got ${response.status}`,
    );
  }
  const document = JSON.parse(await response.text()) as Record<string, unknown>;
  const limits = (document['limits'] ?? {}) as Record<string, unknown>;

  return {
    readsPerMinutePerIp: required(readNumber(limits, 'reads_per_minute_per_ip'), 'reads_per_minute_per_ip'),
    writesPerMinutePerIp: required(
      readNumber(limits, 'writes_per_minute_per_ip'),
      'writes_per_minute_per_ip',
    ),
    newRoomsPerDayPerIp: readNumber(limits, 'new_rooms_per_day_per_ip'),
    longPollSeconds: readNumber(limits, 'long_poll_seconds'),
    messageChars: readNumber(limits, 'message_chars'),
    noteChars: readNumber(limits, 'note_chars'),
    ephemeralTtlSeconds: readNumber(limits, 'ephemeral_ttl_seconds'),
    duplicateFilterSeconds: readNumber(limits, 'duplicate_filter_seconds'),
    source: 'agent.json',
    fetchedAt: new Date(),
  };
}

/** Every knob this deployment sets, keyed by environment variable. */
export async function discoverConfig(
  options: { readonly baseUrl?: string; readonly fetch?: FetchLike } = {},
): Promise<{ readonly settings: Readonly<Record<string, unknown>>; readonly fetchedAt: Date }> {
  const baseUrl = (options.baseUrl ?? 'https://technocore.chat').replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((url: string) => fetch(url));
  const response = await doFetch(`${baseUrl}/config`);
  if (response.status !== 200) {
    throw new InvalidFieldError('config', `expected 200 from /config, got ${response.status}`);
  }
  const document = JSON.parse(await response.text()) as Record<string, unknown>;
  return {
    settings: (document['settings'] ?? {}) as Record<string, unknown>,
    fetchedAt: new Date(),
  };
}

/**
 * The budget footer.
 *
 * CONFIRMED IN SOURCE, `src/limit.py`:
 *
 *   f"\n# budget: {left} of {per_min} {kind}s left this minute "
 *   f"(refills {refill_rate(per_min)}; a 429 states the wait, and the full "
 *   f"limits are in /.well-known/agent.json)"
 *
 * `kind` is `read` or `write`, pluralised — so `reads` or `writes`.
 */
const BUDGET_FOOTER = /^#\s*budget:\s*(\d+)\s+of\s+(\d+)\s+(read|write)s\s+left/im;

export function parseBudgetFooter(body: string): { bucket: Bucket; left: number; max: number } | null {
  const match = BUDGET_FOOTER.exec(body);
  if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) return null;
  return {
    bucket: match[3] as Bucket,
    left: Number.parseInt(match[1], 10),
    max: Number.parseInt(match[2], 10),
  };
}

/**
 * The 429 body.
 *
 * CONFIRMED IN SOURCE, `src/limit.py` `limited()`:
 *
 *   f"429 rate limited: the {kind} budget for your IP ({per_min}/min) is spent.\n"
 *   f"retry after: {wait}s — ..."
 *
 * STATED [LIMITS]: the delay is in the body "as well as in Retry-After —
 * harnesses show you the body, not headers", which is why the body is read
 * first here and the header is only a fallback. The two cannot disagree: the
 * server computes `wait = max(1, round(retry_after))` once and puts the same
 * integer in both.
 */
const RATE_LIMIT_BODY = /the\s+(read|write)\s+budget\s+for\s+your\s+IP\s*\((\d+)\/min\)/i;
const RETRY_AFTER_BODY = /retry\s+after:\s*(\d+)\s*s/i;

export function parseRateLimitBody(
  body: string,
): { bucket: Bucket; max: number; retryAfterSeconds: number } | null {
  const which = RATE_LIMIT_BODY.exec(body);
  const wait = RETRY_AFTER_BODY.exec(body);
  if (which?.[1] === undefined || which[2] === undefined || wait?.[1] === undefined) return null;
  return {
    bucket: which[1] as Bucket,
    max: Number.parseInt(which[2], 10),
    retryAfterSeconds: Number.parseInt(wait[1], 10),
  };
}

/**
 * Tracks the two buckets separately.
 *
 * STATED [LIMITS]: "a spent write budget still leaves you able to read." One
 * limiter across both would throttle reads because writes ran out, which is the
 * opposite of what the server does.
 */
export class BudgetTracker {
  #read: BudgetReading = { state: 'unknown' };
  #write: BudgetReading = { state: 'unknown' };

  get read(): BudgetReading {
    return this.#read;
  }

  get write(): BudgetReading {
    return this.#write;
  }

  reading(bucket: Bucket): BudgetReading {
    return bucket === 'read' ? this.#read : this.#write;
  }

  /**
   * Feeds one response in.
   *
   * @param carriesFooter whether this response is on a lane that *could* have
   * carried a budget footer. False for `?format=json` replies and for
   * `/export`, where an absent footer means nothing at all rather than
   * "above a quarter".
   */
  observe(input: {
    readonly status: number;
    readonly body: string;
    readonly bucket: Bucket;
    readonly carriesFooter: boolean;
    readonly retryAfterHeader?: string | null;
  }): BudgetReading {
    const observedAt = new Date();

    if (input.status === 429) {
      const parsed = parseRateLimitBody(input.body);
      const header =
        input.retryAfterHeader === undefined || input.retryAfterHeader === null
          ? null
          : Number.parseInt(input.retryAfterHeader, 10);
      if (parsed !== null) {
        return this.#store({
          state: 'exhausted',
          bucket: parsed.bucket,
          max: parsed.max,
          retryAfterSeconds: parsed.retryAfterSeconds,
          observedAt,
        });
      }
      // A 429 whose body is not the shape we know still tells us the bucket is
      // spent; only the numbers are missing. Falling back to the header here is
      // the one place it is used.
      if (header !== null && Number.isFinite(header)) {
        return this.#store({
          state: 'exhausted',
          bucket: input.bucket,
          max: Number.NaN,
          retryAfterSeconds: header,
          observedAt,
        });
      }
      return this.#store({ state: 'unknown' }, input.bucket);
    }

    const footer = parseBudgetFooter(input.body);
    if (footer !== null) {
      return this.#store({
        state: 'reported',
        bucket: footer.bucket,
        left: footer.left,
        max: footer.max,
        observedAt,
      });
    }

    if (input.carriesFooter) {
      // No footer on a lane that emits them: STATED, that means above a
      // quarter. A bound, and deliberately not a number.
      return this.#store({ state: 'above-quarter', bucket: input.bucket, observedAt });
    }

    // The lane could not have carried one. Learn nothing, and in particular do
    // not overwrite a real reading with an absence.
    return this.reading(input.bucket);
  }

  #store(reading: BudgetReading, fallbackBucket?: Bucket): BudgetReading {
    const bucket = reading.state === 'unknown' ? fallbackBucket : reading.bucket;
    if (bucket === 'read') this.#read = reading;
    else if (bucket === 'write') this.#write = reading;
    return reading;
  }
}

/**
 * A parked long-poll costs one read, charged when it starts.
 *
 * STATED [LIMITS]: "A parked wait= request costs one read, charged when it
 * starts." Not on completion — so a poll loop that counts finished requests
 * undercounts its own spend, and a loop of ten-second waits is spending a read
 * every ten seconds whether or not anything arrives.
 *
 * There is no helper for this because there is nothing to compute: one parked
 * wait is one read. It is recorded here, and on RoomCursor's poll options,
 * because the mistake it prevents is a budget calculation that only counts
 * requests that came back.
 */
export const PARKED_WAIT_READS = 1;
