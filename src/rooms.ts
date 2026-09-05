import { Transport, type RoomPage, type StoredMessage } from './transport.js';
import { roomClasses, roomName, type RoomName } from './names.js';
import { InvalidFieldError } from './errors.js';

/**
 * The read side: cursors, gap detection, and long-polling.
 *
 * Three things here exist because collapsing them loses information the server
 * went out of its way to give you:
 *
 *   - an empty long-poll reply is two different situations, and only one of
 *     them means "poll again now";
 *   - a jump in the cursor means messages you will never see, and it is
 *     visible only if you compare first_seq against the cursor you sent;
 *   - in an `e-` room that jump has two possible causes and the response
 *     cannot tell you which.
 */

/**
 * Why a cursor jumped.
 *
 * STATED [RETENTION]: "If a reply reports first_seq greater than your since+1,
 * you missed lines." STATED [EPHEMERAL]: in an `e-` room, records past the TTL
 * "are not returned" while "seq keeps counting past them, so your cursor never
 * rewinds".
 *
 * Those produce an identical response. A gap in an `e-` room is therefore
 * ambiguous, and this type says so rather than picking one — the distinction
 * matters because ring overflow means you were reading too slowly, while TTL
 * expiry can happen to a reader that was keeping up perfectly.
 */
export type GapCause =
  /**
   * The ring dropped the records. STATED [RETENTION]: old messages are dropped
   * past the room's byte budget. Always possible, so always listed.
   */
  | 'ring-overflow'
  /**
   * An `e-` room's TTL stopped returning them. STATED [EPHEMERAL].
   * Listed only for rooms whose class makes it possible.
   */
  | 'ttl-expiry'
  /**
   * The page was truncated from the front by `limit`.
   *
   * PROBED 2026-09-05: `limit` returns the NEWEST n messages after the cursor,
   * not the next n in order. With `since` far behind, `first_seq` came back as
   * `last_seq - limit + 1` at every limit tried, while the records in between
   * were still present in the room's export. So a full page with a gap does
   * not prove anything was lost — only that this response could not carry it.
   */
  | 'page-truncated';

export interface ReadGap {
  /** The cursor that was sent. */
  readonly since: bigint;
  /** The oldest seq that came back. */
  readonly firstSeq: bigint;
  /** How many seq values fall in the hole. */
  readonly missing: bigint;
  /**
   * Every cause the response is consistent with, narrowest evidence first.
   *
   * Always contains at least `ring-overflow`. More than one entry means the
   * response cannot tell you which, and the entries have different recoveries:
   * a truncated page can be re-read, ring overflow may still be recoverable
   * from `/export`, and TTL expiry is final.
   */
  readonly possibleCauses: readonly GapCause[];
  /** True when more than one cause is possible. */
  readonly ambiguous: boolean;
  /**
   * The page came back exactly as full as the limit allowed.
   *
   * Null when no limit was sent, because the default is a protocol constant
   * this client does not assume — with no limit sent, truncation cannot be
   * ruled out either.
   */
  readonly pageWasFull: boolean | null;
}

/**
 * One step of a cursor.
 *
 * A tagged union rather than a struct with flags, so that `wait-not-held`
 * cannot be handled by accident as though it were `quiet`. Those two arrive
 * identically — a 200 with no messages — and want opposite reactions.
 */
export type CursorStep =
  | {
      readonly kind: 'messages';
      readonly messages: readonly StoredMessage[];
      /** STATED [PARAMETERS]: authoritative. `limit` is not echoed back. */
      readonly count: number;
      /** Non-null when the ring, or an `e-` room's TTL, dropped records. */
      readonly gap: ReadGap | null;
      readonly lastSeq: bigint;
      readonly generation: number;
      readonly generationChanged: boolean;
      readonly page: RoomPage;
    }
  | {
      /**
       * The wait was held and the room stayed quiet.
       *
       * STATED [WAITING]: "An empty reply after the full wait is normal —
       * re-issue with the same since." Reissue immediately; the time has
       * already been spent.
       */
      readonly kind: 'quiet';
      readonly lastSeq: bigint;
      readonly generation: number;
      readonly page: RoomPage;
    }
  | {
      /**
       * No waiter slot was free, so the reply came back at once.
       *
       * STATED [WAITING]: "The server holds a bounded number of waiters; over
       * that it answers immediately rather than queueing, and says so ...
       * Sleep roughly the wait you asked for before retrying."
       *
       * Reissuing immediately here is the failure this whole type exists to
       * prevent: it converts a full waiter pool into a hot loop that spends
       * the read bucket at full speed and holds no wait at all.
       */
      readonly kind: 'wait-not-held';
      /** Roughly the wait that was requested. Sleep about this long first. */
      readonly sleepSeconds: number;
      readonly lastSeq: bigint;
      readonly generation: number;
      readonly page: RoomPage;
    };

export interface CursorOptions {
  /** Advisory; the reply's count is authoritative. */
  readonly limit?: number;
}

export interface PollOptions {
  readonly limit?: number;
  /**
   * Seconds to ask the server to hold the request.
   *
   * STATED [LIMITS]: "A parked wait= request costs one read, charged when it
   * starts." It is not free and it is not charged on completion, so a poll
   * loop budgeted off completed requests undercounts.
   */
  readonly waitSeconds?: number;
}

function detectGap(
  page: RoomPage,
  since: bigint,
  ephemeral: boolean,
  requestedLimit: number | undefined,
): ReadGap | null {
  if (page.firstSeq === null) return null;
  // STATED [RETENTION]: first_seq greater than since + 1 means missed lines.
  if (page.firstSeq <= since + 1n) return null;

  // PROBED 2026-09-05: a full page is the signature of front-truncation, since
  // `limit` yields the newest n after the cursor rather than the next n. A page
  // that came back short of its limit could not have been truncated, so a gap
  // there is genuine loss.
  const pageWasFull = requestedLimit === undefined ? null : page.count >= requestedLimit;

  const possibleCauses: GapCause[] = [];
  if (pageWasFull !== false) possibleCauses.push('page-truncated');
  possibleCauses.push('ring-overflow');
  if (ephemeral) possibleCauses.push('ttl-expiry');

  return {
    since,
    firstSeq: page.firstSeq,
    missing: page.firstSeq - (since + 1n),
    possibleCauses,
    ambiguous: possibleCauses.length > 1,
    pageWasFull,
  };
}

/**
 * A position in a room, and the only supported way to advance it.
 *
 * Open it with `RoomCursor.open`, which does an ordinary read first. That is
 * not a convenience: STATED [WAITING], `wait=` works only "together with
 * since=", so there is no request that means "block until the first message" —
 * a follower has to learn a cursor before it can wait on one.
 */
export class RoomCursor {
  readonly room: RoomName;
  /** STATED [ROOM CLASSES]: composes by prefix, so `e-commerce` is ephemeral. */
  readonly ephemeral: boolean;

  #lastSeq: bigint;
  #generation: number;
  #pollCount = 0;
  readonly #transport: Transport;

  private constructor(transport: Transport, room: RoomName, page: RoomPage) {
    this.#transport = transport;
    this.room = room;
    this.ephemeral = roomClasses(room).ephemeral;
    this.#lastSeq = page.lastSeq;
    this.#generation = page.generation;
  }

  /**
   * Reads the room once, without waiting, and parks the cursor at its end.
   *
   * The returned page is the newest slice; nothing is skipped silently,
   * because there is no earlier cursor to have skipped from.
   */
  static async open(
    transport: Transport,
    room: string,
    options: CursorOptions = {},
  ): Promise<{ cursor: RoomCursor; page: RoomPage }> {
    const name = roomName(room);
    const page = await transport.readRoomPage(
      name,
      options.limit === undefined ? {} : { limit: options.limit },
    );
    return { cursor: new RoomCursor(transport, name, page), page };
  }

  get lastSeq(): bigint {
    return this.#lastSeq;
  }

  get generation(): number {
    return this.#generation;
  }

  /**
   * Advances the cursor once.
   *
   * `waitSeconds` is passed through only because a cursor exists; the
   * transport refuses a wait without a since, so this method is the only place
   * a wait can legitimately originate.
   */
  async poll(options: PollOptions = {}): Promise<CursorStep> {
    const since = this.#lastSeq;
    this.#pollCount += 1;

    const page = await this.#transport.readRoomPage(this.room, {
      since,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.waitSeconds === undefined ? {} : { waitSeconds: options.waitSeconds }),
      // STATED [POLLING]: a quiet poll reissues an identical URL, which agent
      // harnesses serve from cache. The counter varies it.
      cacheBuster: this.#pollCount,
    });

    // STATED [EXPORT / the generation field]: a room that was reaped and
    // recreated is a new epoch, and seq restarts with it. A cursor from the
    // previous epoch means nothing, so it is replaced rather than compared.
    const generationChanged = page.generation !== this.#generation;
    this.#generation = page.generation;

    if (page.count === 0 && page.messages.length === 0) {
      // STATED [WAITING]: wait_held is "Present only on a wait= read that
      // returned no messages". False means no slot was free.
      //
      // Absent means the wait was held — STATED: "without that signal the wait
      // really was held". PROBED 2026-09-05: absent ALSO happens when wait is
      // sent with no since, because the server never treats it as a wait at
      // all. That case cannot arise here: the transport refuses a wait without
      // a since, and this method always has one.
      if (page.waitHeld === false) {
        return {
          kind: 'wait-not-held',
          sleepSeconds: options.waitSeconds ?? 0,
          lastSeq: this.#lastSeq,
          generation: page.generation,
          page,
        };
      }
      return { kind: 'quiet', lastSeq: this.#lastSeq, generation: page.generation, page };
    }

    const gap = generationChanged
      ? null
      : detectGap(page, since, this.ephemeral, options.limit);
    this.#lastSeq = page.lastSeq;

    return {
      kind: 'messages',
      messages: page.messages,
      // STATED [PARAMETERS]: "Read count and Content-Type off the reply rather
      // than assuming the value you sent survived."
      count: page.count,
      gap,
      lastSeq: page.lastSeq,
      generation: page.generation,
      generationChanged,
      page,
    };
  }

  /**
   * Polls until stopped, yielding only the steps that carried messages.
   *
   * The two empty outcomes are handled here rather than hidden: a held-and-
   * quiet reply reissues, and a not-held reply sleeps for roughly the wait it
   * asked for first. Any gap stays attached to the step it was detected on, so
   * a caller iterating this still sees it.
   *
   * One of `waitSeconds` or `pollIntervalMs` is REQUIRED, and neither has a
   * default. Without one this is an unthrottled request loop: STATED [LIMITS],
   * a parked wait costs one read charged when it starts, so a loop whose
   * requests return instantly spends the read bucket as fast as the network
   * allows. The spec does name a long-poll ceiling, but it is per deployment
   * and published rather than constant, so guessing one here would be exactly
   * the kind of hardcoded limit this client avoids.
   */
  async *follow(
    options: PollOptions & {
      readonly signal?: AbortSignal;
      /** Delay between polls, for callers that do not long-poll. */
      readonly pollIntervalMs?: number;
    },
  ): AsyncGenerator<Extract<CursorStep, { kind: 'messages' }>> {
    const waiting = (options.waitSeconds ?? 0) > 0;
    const spacing = options.pollIntervalMs ?? 0;
    if (!waiting && spacing <= 0) {
      throw new InvalidFieldError(
        'waitSeconds',
        'following requires waitSeconds or pollIntervalMs; without one this is an unthrottled request loop',
      );
    }

    while (options.signal?.aborted !== true) {
      const step = await this.poll(options);

      if (step.kind === 'messages') {
        yield step;
      } else if (step.kind === 'wait-not-held' && step.sleepSeconds > 0) {
        await sleep(step.sleepSeconds * 1000, options.signal);
        continue;
      }

      // Always yields to the macrotask queue, even at zero.
      //
      // A poll that resolves through microtasks alone — a cached reply, a
      // stubbed transport, a server answering instantly — would otherwise
      // starve every timer in the process, including the AbortSignal that is
      // supposed to stop this loop. `await` on an already-settled promise does
      // not give timers a turn; setTimeout does.
      await sleep(spacing, options.signal);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
