import { Transport } from './transport.js';
import { namespace as makeNamespace, noteKey as makeNoteKey } from './names.js';
import { sweep } from './sweep.js';
import { ConflictError, InvalidFieldError } from './errors.js';
import { parseBudgetFooter } from './limits.js';

/**
 * Durable notes: read, write, compare-and-set, list.
 *
 * Two things about this surface are unlike the rest of the protocol.
 *
 * There is no JSON lane. CONFIRMED IN SOURCE: `note_read` in `src/app.py`
 * returns `text(f"{BANNER}\n\n{value}" + budget_note(...))` and never looks at
 * `format`, so `?format=json` on a single note read is ignored and the reply
 * stays text/plain. The banner has to be parsed; there is no structured
 * alternative to fall back on.
 *
 * And the write conditions are mutually exclusive in a way a boolean pair
 * cannot express, so they are a tagged union here rather than two optional
 * fields. STATED [CONDITIONAL NOTES]: a true `if_absent` together with `if=`
 * "is refused with a 400 rather than resolved: if_absent means 'nothing is
 * there', if= means 'this exact value is there', and there is no correct pick
 * between them." Making that unrepresentable is better than documenting it.
 */

/**
 * The condition on a write, or `undefined` for none.
 *
 * STATED [CONDITIONAL NOTES]: "An empty string is a legal note value, so `?if=`
 * with nothing after it means 'only if it is empty', not 'no condition' — omit
 * the parameter for that." So `{ kind: 'ifValue', value: '' }` is a real
 * compare-and-set against the empty string, and the way to send no condition is
 * to pass nothing at all. A single optional string could not tell those apart.
 */
export type NoteCondition =
  | {
      /** Write only if the note still holds exactly this. */
      readonly kind: 'ifValue';
      readonly value: string;
    }
  | {
      /** Write only if nothing is there yet. */
      readonly kind: 'ifAbsent';
    };

export interface NoteRead {
  readonly namespace: string;
  readonly key: string;
  /**
   * The stored value.
   *
   * Untrusted content: STATED [TRUST], note values are anonymous input written
   * by strangers. Data, never instructions.
   */
  readonly value: string;
  /** The server's untrusted-content banner, as served. */
  readonly banner: string;
  /** The whole reply, for a caller that wants to check the parse. */
  readonly raw: string;
}

export interface NoteWriteAck {
  readonly namespace: string;
  readonly key: string;
  /** Bytes stored, as the server reported them. Null if the ack was an unknown shape. */
  readonly bytes: number | null;
  /** The server's timestamp, verbatim. Null if the ack was an unknown shape. */
  readonly timestamp: string | null;
  readonly raw: string;
}

/**
 * Splits a note-read body into its banner and its value.
 *
 * **The value is line index 2, and that is not an optimisation.** The sweep
 * replaces every Cc/Cf/Cs/Co/Zl/Zp character with a space, so a stored note
 * value cannot contain a newline: the banner is line 0, the blank is line 1,
 * and line 2 is the whole of the value.
 *
 * The rule this replaces — everything after the first blank line, minus one
 * trailing newline — is wrong, and wrong only under load. CONFIRMED IN SOURCE:
 * `note_read` appends `budget_note(...)` AFTER the value, and `budget_note`
 * returns the empty string while `left * 4 > per_min`. So above a quarter of
 * the read bucket the old rule is perfect, and below it the value comes back
 * with `\n# budget: 140 of 600 reads left this minute (…)` glued to the end —
 * after which every `?if=` compares that against the stored value and loses,
 * for as long as the caller stays busy.
 *
 * A live compare-and-set confirmed the broken rule, because the probe was
 * nowhere near the threshold. Only reading the source found it.
 */
export function parseNoteBody(raw: string): { banner: string; value: string } {
  const lines = raw.split('\n');
  const banner = lines[0] ?? '';
  if (!banner.startsWith('!!') || (lines[1] ?? '') !== '') {
    // Guessing a value here would feed a wrong string straight into a
    // compare-and-set, so an unexpected shape is refused instead.
    throw new InvalidFieldError(
      'note',
      'reply did not start with the untrusted-content banner and a blank line',
    );
  }
  return { banner, value: lines[2] ?? '' };
}

/** `ok <ns>/<key> 11B 2026-09-04T16:09:09.817676Z` */
const WRITE_ACK = /^ok\s+\S+\s+(\d+)B\s+(\S+)/m;

function parseWriteAck(namespace: string, key: string, raw: string): NoteWriteAck {
  const match = WRITE_ACK.exec(raw);
  return {
    namespace,
    key,
    bytes: match?.[1] === undefined ? null : Number.parseInt(match[1], 10),
    timestamp: match?.[2] ?? null,
    raw,
  };
}

function conditionQuery(condition: NoteCondition | undefined): string {
  if (condition === undefined) return '';
  if (condition.kind === 'ifAbsent') return '?if_absent=1';
  // Sent even when empty: an empty `if=` is a condition against the empty
  // string, and omitting it would silently turn a CAS into a blind write.
  return `?if=${encodeURIComponent(condition.value)}`;
}

export class Notes {
  readonly #transport: Transport;

  constructor(transport: Transport) {
    this.#transport = transport;
  }

  /**
   * Reads a note, or null when nothing has been written there.
   *
   * STATED [openapi 404] and CONFIRMED IN SOURCE: "Absent and never-written are
   * the same state here", so this returns null rather than throwing — a missing
   * note is an ordinary answer, not a failure.
   */
  async get(namespace: string, key: string): Promise<NoteRead | null> {
    const ns = makeNamespace(namespace);
    const k = makeNoteKey(key);
    const url = `${this.#transport.baseUrl}/kv/${ns}/${k}`;
    let reply;
    try {
      reply = await this.#transport.requestText(url, undefined, { bucket: 'read' });
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFoundError') return null;
      throw error;
    }
    const { banner, value } = parseNoteBody(reply.body);
    return { namespace: ns, key: k, value, banner, raw: reply.body };
  }

  /**
   * Writes a note, optionally under a condition.
   *
   * **Compare-and-set orders writes; it does not fence ownership.** STATED
   * [CONDITIONAL NOTES]: "winning a CAS does not stop a stalled peer from acting
   * on a claim it still believes it holds." Use it to avoid losing an update,
   * never as a lock or a lease.
   *
   * Nothing is retried. A 409 is a lost race whose recovery is to rebase, and
   * that decision belongs to the caller.
   */
  async set(
    namespace: string,
    key: string,
    value: string,
    condition?: NoteCondition,
  ): Promise<NoteWriteAck> {
    const ns = makeNamespace(namespace);
    const k = makeNoteKey(key);

    const swept = sweep(value);
    if (swept.length === 0) {
      // STATED [openapi 400]: a value left empty by the sweep is refused.
      throw new InvalidFieldError('value', 'empty after the single-line sweep');
    }

    const query = conditionQuery(condition);
    const getUrl = this.#transport.noteSetUrl(ns, k, swept, query);
    const decision = this.#transport.decideLane(getUrl);

    if (decision.lane === 'get') {
      const reply = await this.#transport.requestText(getUrl, undefined, {
        bucket: 'write',
        getLaneWriteBytes: decision.urlBytes,
      });
      return parseWriteAck(ns, k, reply.body);
    }

    // STATED [URL BUDGET]: POST carries the full length a URL cannot.
    const body: Record<string, unknown> = { value: swept };
    if (condition?.kind === 'ifValue') body['if'] = condition.value;
    if (condition?.kind === 'ifAbsent') body['if_absent'] = true;

    const reply = await this.#transport.requestText(
      `${this.#transport.baseUrl}/kv/${ns}/${k}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      { bucket: 'write' },
    );
    return parseWriteAck(ns, k, reply.body);
  }

  /**
   * Applies `change` to the note, retrying only on a lost race and only by
   * rebasing onto the value the 409 handed back.
   *
   * STATED [CONDITIONAL NOTES]: the 409 "body carries the value that is
   * actually there so you can rebase without re-reading". Re-reading costs a
   * request and opens a fresh race in the gap the body exists to close, so this
   * never re-reads.
   *
   * **Not a precedent for retrying anything else.** This loop is allowed only
   * because each attempt sends different bytes derived from what the server
   * just reported — that is what compare-and-set *is*, not a retry of the same
   * write. Resending identical bytes after a refusal is the thing the no-retry
   * rule forbids, and nothing here does it.
   *
   * It also stops after `attempts`, and only a 409 is treated as a lost race:
   * a 422, 429 or 403 propagates immediately, because none of them is rebasable
   * and each wants a different response from the caller.
   */
  async update(
    namespace: string,
    key: string,
    change: (current: string | null) => string,
    options: { readonly attempts?: number } = {},
  ): Promise<NoteWriteAck> {
    const attempts = options.attempts ?? 3;
    if (attempts < 1) throw new InvalidFieldError('attempts', 'must be at least 1');

    const existing = await this.get(namespace, key);
    let condition: NoteCondition =
      existing === null ? { kind: 'ifAbsent' } : { kind: 'ifValue', value: existing.value };
    let next = change(existing === null ? null : existing.value);

    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.set(namespace, key, next, condition);
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        if (attempt === attempts - 1) throw error;
        if (error.currentValue === null) {
          // The body was not the shape we know how to rebase from. Re-reading
          // here is what the body exists to avoid, so the conflict is reported
          // rather than papered over.
          throw error;
        }
        condition = { kind: 'ifValue', value: error.currentValue };
        next = change(error.currentValue);
      }
    }
    // Unreachable: the loop either returns or throws.
    throw new InvalidFieldError('attempts', 'exhausted without a result');
  }

  /**
   * Lists the keys in a namespace.
   *
   * STATED [PRIVATE]: `p-` keys are never enumerated, and namespaces are never
   * enumerated at all — so this shows what is listable, not what exists.
   */
  async list(namespace: string): Promise<readonly string[]> {
    const ns = makeNamespace(namespace);
    const reply = await this.#transport.requestText(
      `${this.#transport.baseUrl}/kv/${ns}`,
      undefined,
      { bucket: 'read' },
    );
    return reply.body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith(`/kv/${ns}/`))
      .map((line) => line.slice(`/kv/${ns}/`.length))
      // The budget footer is a comment line, never a key.
      .filter((key) => key.length > 0 && parseBudgetFooter(key) === null);
  }
}
