import { describe, expect, it } from 'vitest';
import { Transport } from '../src/transport.js';
import { RoomCursor } from '../src/rooms.js';
import { InvalidFieldError } from '../src/errors.js';

interface PageShape {
  room?: string;
  count?: number;
  first_seq?: number | null;
  last_seq?: number;
  generation?: number;
  messages?: unknown[];
  wait_held?: boolean;
}

function page(shape: PageShape = {}): string {
  const messages = shape.messages ?? [];
  const body: Record<string, unknown> = {
    room: shape.room ?? 'p-test',
    count: shape.count ?? messages.length,
    first_seq: shape.first_seq === undefined ? (messages.length > 0 ? 1 : null) : shape.first_seq,
    last_seq: shape.last_seq ?? 0,
    generation: shape.generation ?? 0,
    messages,
  };
  if (shape.wait_held !== undefined) body['wait_held'] = shape.wait_held;
  return JSON.stringify(body);
}

function message(seq: number, text = 'hi') {
  return { seq, ts: '2026-09-05T00:00:00.000000Z', from: 'probe', text };
}

/** Serves a scripted list of responses and records every URL it was asked for. */
function scripted(responses: { status?: number; body: string; contentType?: string }[]) {
  const urls: string[] = [];
  let index = 0;
  const fn = async (url: string) => {
    urls.push(url);
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(next?.body ?? '', {
      status: next?.status ?? 200,
      headers: { 'content-type': next?.contentType ?? 'application/json' },
    });
  };
  return { fn, urls };
}

describe('bootstrap: wait is never sent without a real since', () => {
  it('opens with an ordinary read that carries no wait', async () => {
    // STATED [WAITING]: wait works only together with since=, so there is no
    // request meaning "block until the first message". A follower has to learn
    // a cursor first.
    const mock = scripted([{ body: page({ last_seq: 7, messages: [message(7)] }) }]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'p-test');
    expect(mock.urls[0]).not.toContain('wait=');
    expect(mock.urls[0]).not.toContain('since=');
    expect(cursor.lastSeq).toBe(7n);
  });

  it('sends the cursor on every subsequent poll', async () => {
    const mock = scripted([
      { body: page({ last_seq: 7, messages: [message(7)] }) },
      { body: page({ last_seq: 7, wait_held: true }) },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'p-test');
    await cursor.poll({ waitSeconds: 10 });
    expect(mock.urls[1]).toContain('since=7');
    expect(mock.urls[1]).toContain('wait=10');
  });

  it('refuses a wait with no cursor at the transport layer', async () => {
    const mock = scripted([{ body: page() }]);
    const transport = new Transport({ fetch: mock.fn });
    await expect(transport.readRoomPage('p-test', { waitSeconds: 10 })).rejects.toThrow(
      InvalidFieldError,
    );
    // PROBED 2026-09-05: sent alone the server ignores it, returns at once,
    // and omits wait_held entirely. Spending a read for that is worse than an
    // error.
    expect(mock.urls).toHaveLength(0);
  });

  it('varies the URL between quiet polls so a cache cannot answer them', async () => {
    // STATED [POLLING]: a re-poll of an unchanged URL should carry &n=<counter>.
    const mock = scripted([
      { body: page({ last_seq: 3, messages: [message(3)] }) },
      { body: page({ last_seq: 3, wait_held: true }) },
      { body: page({ last_seq: 3, wait_held: true }) },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'p-test');
    await cursor.poll({ waitSeconds: 10 });
    await cursor.poll({ waitSeconds: 10 });
    expect(mock.urls[1]).not.toBe(mock.urls[2]);
    expect(mock.urls[1]).toContain('n=1');
    expect(mock.urls[2]).toContain('n=2');
  });
});

describe('the two empty replies are different outcomes', () => {
  it('reports a held-but-quiet wait as quiet, to be reissued at once', async () => {
    const mock = scripted([
      { body: page({ last_seq: 5, messages: [message(5)] }) },
      { body: page({ last_seq: 5, wait_held: true }) },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'p-test');
    const step = await cursor.poll({ waitSeconds: 10 });
    expect(step.kind).toBe('quiet');
    expect(cursor.lastSeq).toBe(5n);
  });

  it('reports wait_held false as its own outcome, carrying a sleep', async () => {
    // STATED [WAITING]: "no long-poll slot was free, so the reply is immediate
    // rather than waited — sleep about the wait you asked for first, or you
    // re-read for nothing."
    const mock = scripted([
      { body: page({ last_seq: 5, messages: [message(5)] }) },
      { body: page({ last_seq: 5, wait_held: false }) },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'p-test');
    const step = await cursor.poll({ waitSeconds: 10 });
    expect(step.kind).toBe('wait-not-held');
    if (step.kind !== 'wait-not-held') throw new Error('unreachable');
    expect(step.sleepSeconds).toBe(10);
  });

  it('does not let the two be confused for one another', () => {
    // The whole point of the tagged union: collapsing these turns a full
    // waiter pool into a hot loop that spends the read bucket at full speed.
    const kinds = ['messages', 'quiet', 'wait-not-held'] as const;
    expect(new Set(kinds).size).toBe(3);
  });

  it('treats an absent wait_held as held, per the spec', async () => {
    // STATED: "without that signal the wait really was held". Safe here only
    // because this client never sends a wait without a since, which is the one
    // case probed to omit the field for a different reason.
    const mock = scripted([
      { body: page({ last_seq: 5, messages: [message(5)] }) },
      { body: page({ last_seq: 5 }) },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'p-test');
    const step = await cursor.poll({ waitSeconds: 10 });
    expect(step.kind).toBe('quiet');
  });
});

describe('gap detection', () => {
  it('reports a gap when first_seq exceeds since + 1', async () => {
    // STATED [RETENTION]: "If a reply reports first_seq greater than your
    // since+1, you missed lines."
    const mock = scripted([
      { body: page({ last_seq: 10, first_seq: 10, messages: [message(10)] }) },
      {
        body: page({
          last_seq: 40,
          first_seq: 31,
          messages: [message(31), message(40)],
          count: 2,
        }),
      },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'p-test');
    const step = await cursor.poll({ limit: 50 });
    if (step.kind !== 'messages') throw new Error('expected messages');
    expect(step.gap).not.toBeNull();
    expect(step.gap?.since).toBe(10n);
    expect(step.gap?.firstSeq).toBe(31n);
    expect(step.gap?.missing).toBe(20n);
  });

  it('reports no gap when the slice is contiguous with the cursor', async () => {
    const mock = scripted([
      { body: page({ last_seq: 10, first_seq: 10, messages: [message(10)] }) },
      { body: page({ last_seq: 12, first_seq: 11, messages: [message(11), message(12)] }) },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'p-test');
    const step = await cursor.poll();
    if (step.kind !== 'messages') throw new Error('expected messages');
    expect(step.gap).toBeNull();
    expect(cursor.lastSeq).toBe(12n);
  });

  it('never swallows a gap: it rides on the step the caller receives', async () => {
    const mock = scripted([
      { body: page({ last_seq: 1, first_seq: 1, messages: [message(1)] }) },
      { body: page({ last_seq: 100, first_seq: 90, messages: [message(90)] }) },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'p-test');
    const seen: unknown[] = [];
    for await (const step of cursor.follow({ pollIntervalMs: 5, signal: AbortSignal.timeout(50) })) {
      seen.push(step.gap);
      break;
    }
    expect(seen[0]).not.toBeNull();
  });

  it('calls the cause unambiguous in a plain room', async () => {
    const mock = scripted([
      { body: page({ last_seq: 5, first_seq: 5, messages: [message(5)] }) },
      { body: page({ last_seq: 20, first_seq: 15, messages: [message(15)] }) },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'lobby');
    const step = await cursor.poll({ limit: 50 });
    if (step.kind !== 'messages') throw new Error('expected messages');
    // The page came back short of its limit, so truncation is ruled out and
    // the ring is the only remaining explanation.
    expect(step.gap?.possibleCauses).toEqual(['ring-overflow']);
    expect(step.gap?.ambiguous).toBe(false);
    expect(step.gap?.pageWasFull).toBe(false);
  });

  it('states the ambiguity in an e- room', async () => {
    // STATED [EPHEMERAL]: records past the TTL stop being returned while seq
    // keeps counting, so a gap there may be expiry rather than overflow — and
    // the response cannot say which.
    const mock = scripted([
      { body: page({ last_seq: 5, first_seq: 5, messages: [message(5)] }) },
      { body: page({ last_seq: 20, first_seq: 15, messages: [message(15)] }) },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'e-p-abc');
    expect(cursor.ephemeral).toBe(true);
    const step = await cursor.poll({ limit: 50 });
    if (step.kind !== 'messages') throw new Error('expected messages');
    expect(step.gap?.possibleCauses).toEqual(['ring-overflow', 'ttl-expiry']);
    expect(step.gap?.ambiguous).toBe(true);
  });

  it('treats a room whose name merely starts with e- as ephemeral', async () => {
    // STATED [ROOM CLASSES]: a room about e-commerce named `e-commerce` IS
    // ephemeral, so its gaps carry the ambiguous cause too.
    const mock = scripted([{ body: page({ last_seq: 1, messages: [message(1)] }) }]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'e-commerce');
    expect(cursor.ephemeral).toBe(true);
  });
});

describe('generation changes invalidate the cursor', () => {
  it('flags the change and does not report a spurious gap', async () => {
    // A reaped and recreated room restarts seq, so comparing the old cursor
    // against the new epoch would manufacture a gap that never happened.
    const mock = scripted([
      { body: page({ last_seq: 900, first_seq: 900, generation: 1, messages: [message(900)] }) },
      { body: page({ last_seq: 2, first_seq: 1, generation: 2, messages: [message(1), message(2)] }) },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'p-test');
    const step = await cursor.poll();
    if (step.kind !== 'messages') throw new Error('expected messages');
    expect(step.generationChanged).toBe(true);
    expect(step.gap).toBeNull();
    expect(cursor.generation).toBe(2);
    expect(cursor.lastSeq).toBe(2n);
  });
});

describe('limit is advisory; the reply is authoritative', () => {
  it('reports the count the server sent, not the limit that was asked for', async () => {
    // STATED [PARAMETERS]: limit is "clamped or defaulted, never refused", and
    // the value sent is not echoed back anywhere.
    const mock = scripted([
      { body: page({ last_seq: 1, messages: [message(1)] }) },
      { body: page({ last_seq: 4, first_seq: 2, messages: [message(2), message(3), message(4)], count: 3 }) },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'p-test');
    const step = await cursor.poll({ limit: 200 });
    if (step.kind !== 'messages') throw new Error('expected messages');
    expect(step.count).toBe(3);
    expect(step.messages).toHaveLength(3);
    expect(mock.urls[1]).toContain('limit=200');
  });

  it('omits limit entirely when none was given', async () => {
    const mock = scripted([{ body: page({ last_seq: 1, messages: [message(1)] }) }]);
    const transport = new Transport({ fetch: mock.fn });
    await RoomCursor.open(transport, 'p-test');
    expect(mock.urls[0]).not.toContain('limit=');
  });
});

describe('an ignored format is never parsed as JSON', () => {
  it('refuses a 200 that came back as text/plain', async () => {
    // STATED [PARAMETERS]: "any format other than the literal json leaves the
    // reply as text/plain". A 200 is not a promise of JSON.
    const mock = scripted([
      { body: '# room p-test  messages 1  range 5..5', contentType: 'text/plain' },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    await expect(RoomCursor.open(transport, 'p-test')).rejects.toThrow(/expected application\/json/);
  });

  it('refuses a text/plain reply mid-poll rather than half-advancing', async () => {
    const mock = scripted([
      { body: page({ last_seq: 5, messages: [message(5)] }) },
      { body: '# wait: not held', contentType: 'text/plain' },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'p-test');
    await expect(cursor.poll({ waitSeconds: 10 })).rejects.toThrow(/expected application\/json/);
    // The cursor did not move on a reply it could not read.
    expect(cursor.lastSeq).toBe(5n);
  });

  it('accepts a content type that carries a charset', async () => {
    const mock = scripted([
      {
        body: page({ last_seq: 5, messages: [message(5)] }),
        contentType: 'application/json; charset=utf-8',
      },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'p-test');
    expect(cursor.lastSeq).toBe(5n);
  });
});

describe('follow', () => {
  it('sleeps on a not-held reply instead of hammering', async () => {
    const mock = scripted([
      { body: page({ last_seq: 1, messages: [message(1)] }) },
      { body: page({ last_seq: 1, wait_held: false }) },
      { body: page({ last_seq: 2, first_seq: 2, messages: [message(2)] }) },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'p-test');
    const started = Date.now();
    for await (const step of cursor.follow({ waitSeconds: 0.05, signal: AbortSignal.timeout(2000) })) {
      expect(step.kind).toBe('messages');
      break;
    }
    // It waited rather than reissuing immediately after the not-held reply.
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });

  it('stops when the signal aborts', async () => {
    const mock = scripted([
      { body: page({ last_seq: 1, messages: [message(1)] }) },
      { body: page({ last_seq: 1, wait_held: true }) },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'p-test');
    const yielded: unknown[] = [];
    for await (const step of cursor.follow({ pollIntervalMs: 5, signal: AbortSignal.timeout(120) })) {
      yielded.push(step);
    }
    expect(yielded).toHaveLength(0);
  });
});

describe('follow cannot become an unthrottled request loop', () => {
  it('refuses to follow with neither a wait nor a poll interval', async () => {
    // Without one of the two this is a bare loop of instant requests. STATED
    // [LIMITS]: a parked wait costs one read charged when it starts, so a loop
    // whose replies return immediately spends the read bucket at network speed.
    // No default is invented here: the long-poll ceiling is per deployment and
    // published, not a constant this client may assume.
    const mock = scripted([{ body: page({ last_seq: 1, messages: [message(1)] }) }]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'p-test');
    await expect(async () => {
      for await (const _step of cursor.follow({})) {
        break;
      }
    }).rejects.toThrow(/waitSeconds or pollIntervalMs/);
  });

  it('still observes an abort when every reply resolves instantly', async () => {
    // The bug this guards: a poll that settles through microtasks alone starves
    // the macrotask queue, so the AbortSignal timer that is supposed to stop
    // the loop never fires and the generator spins forever. Yielding through
    // setTimeout on every iteration is what makes the signal observable.
    const mock = scripted([
      { body: page({ last_seq: 1, messages: [message(1)] }) },
      { body: page({ last_seq: 1, wait_held: true }) },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'p-test');
    const started = Date.now();
    for await (const _step of cursor.follow({
      pollIntervalMs: 1,
      signal: AbortSignal.timeout(80),
    })) {
      // Never reached: every reply after the first is quiet.
    }
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(4000);
  });
});

describe('a full page cannot prove the ring dropped anything', () => {
  // PROBED 2026-09-05 against /r/technocore: with the cursor far behind,
  // since=4602317 returned first_seq = last_seq - limit + 1 at every limit
  // tried (50, then 200), while the records in between were still present in
  // the room's export. limit yields the NEWEST n after the cursor, not the
  // next n, so a full page with a gap says only that this response could not
  // carry the middle.
  it('lists truncation alongside overflow when the page came back full', async () => {
    const mock = scripted([
      { body: page({ last_seq: 10, first_seq: 10, messages: [message(10)] }) },
      {
        body: page({
          last_seq: 1000,
          first_seq: 999,
          messages: [message(999), message(1000)],
          count: 2,
        }),
      },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'p-test');
    const step = await cursor.poll({ limit: 2 });
    if (step.kind !== 'messages') throw new Error('expected messages');
    expect(step.gap?.pageWasFull).toBe(true);
    expect(step.gap?.possibleCauses).toContain('page-truncated');
    expect(step.gap?.possibleCauses).toContain('ring-overflow');
    expect(step.gap?.ambiguous).toBe(true);
  });

  it('cannot rule truncation out when no limit was sent', async () => {
    // The fallback limit is a protocol constant this client does not assume,
    // so with nothing sent there is no page size to compare the count against.
    const mock = scripted([
      { body: page({ last_seq: 10, first_seq: 10, messages: [message(10)] }) },
      { body: page({ last_seq: 90, first_seq: 80, messages: [message(80)], count: 1 }) },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'p-test');
    const step = await cursor.poll();
    if (step.kind !== 'messages') throw new Error('expected messages');
    expect(step.gap?.pageWasFull).toBeNull();
    expect(step.gap?.possibleCauses).toContain('page-truncated');
  });

  it('always lists ring-overflow, which is never excluded by evidence', async () => {
    const mock = scripted([
      { body: page({ last_seq: 1, first_seq: 1, messages: [message(1)] }) },
      { body: page({ last_seq: 50, first_seq: 40, messages: [message(40)], count: 1 }) },
    ]);
    const transport = new Transport({ fetch: mock.fn });
    const { cursor } = await RoomCursor.open(transport, 'e-p-abc');
    const step = await cursor.poll({ limit: 10 });
    if (step.kind !== 'messages') throw new Error('expected messages');
    expect(step.gap?.possibleCauses).toEqual(['ring-overflow', 'ttl-expiry']);
  });
});
