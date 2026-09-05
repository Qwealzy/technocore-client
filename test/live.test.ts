import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Transport } from '../src/transport.js';
import { Identity } from '../src/identity.js';
import { verifyStoredMessage } from '../src/verify.js';
import { roomClasses } from '../src/names.js';
import { RoomCursor } from '../src/rooms.js';
import { discoverLimits, discoverConfig } from '../src/limits.js';
import { Notes } from '../src/notes.js';
import { ConflictError } from '../src/errors.js';

/**
 * Live integration against a real deployment. Skipped unless TECHNOCORE_LIVE=1,
 * so `npm test` stays hermetic and spends nobody's rate budget.
 *
 * Every write goes into a freshly minted `p-` room. STATED [PRIVATE]: a `p-`
 * room is reachable but never enumerated, and STATED [CONVENTIONS]: "the room
 * name IS the key". Nothing here touches `lobby` or any shared room.
 *
 * The identity is generated per run and thrown away. No key file is read.
 */
const live = process.env['TECHNOCORE_LIVE'] === '1';

/**
 * A strictly increasing nonce.
 *
 * STATED [SIGNING]: a nonce must be greater than the last one that key used in
 * that room, and a millisecond clock is an acceptable source. A bare
 * Date.now() is not, though: two writes inside the same millisecond produce
 * equal nonces, and the second is refused. Seeding from the clock and counting
 * up keeps the clock's ordering without its resolution limit.
 */
let nonceCounter = Date.now();
function nextNonce(): string {
  nonceCounter += 1;
  return String(nonceCounter);
}

describe.skipIf(!live)('live: a signed write goes out and comes back verifiable', () => {
  const transport = new Transport();

  it('lands on the GET lane and re-verifies from the server record', async () => {
    const identity = Identity.create();
    const room = 'p-' + randomBytes(10).toString('hex');
    expect(roomClasses(room).unlisted).toBe(true);

    // STATED [SIGNING]: a millisecond clock is an acceptable nonce source, and
    // it must exceed the last nonce this key used in this room. The room is new
    // and the key is new, so any value works.
    const nonce = nextNonce();
    const result = await transport.sendSignedMessage(identity, room, nonce, '  probe one  ');

    expect(result.lane).toBe('get');
    expect(result.text).toBe('probe one');

    const record = result.page.messages.find((m) => m.text === 'probe one');
    expect(record, 'the write should appear in the page the server returned').toBeDefined();
    expect(record?.from).toBe(identity.did);
    expect(record?.sig).toBeDefined();
    expect(record?.nonce).toBe(nonce);

    // The point of the whole increment: the signature the SERVER stored
    // verifies offline against the record the SERVER returned.
    expect(
      verifyStoredMessage({
        room,
        nonce: record?.nonce as string,
        text: record?.text as string,
        did: record?.from as string,
        sig: record?.sig as string,
      }),
    ).toBe(true);

    // And again from an independent read, not just from the write's reply.
    const page = await transport.readRoomPage(room, { limit: 10 });
    const reread = page.messages.find((m) => m.text === 'probe one');
    expect(
      verifyStoredMessage({
        room,
        nonce: reread?.nonce as string,
        text: reread?.text as string,
        did: reread?.from as string,
        sig: reread?.sig as string,
      }),
    ).toBe(true);
  });

  it('falls back to POST when the encoded URL is too long, and still verifies', async () => {
    const identity = Identity.create();
    const room = 'p-' + randomBytes(10).toString('hex');
    // STATED [URL BUDGET]: an emoji costs 12 URL bytes. 2000 of them is well
    // inside the 4096-character message cap and well past a 16 KB URL.
    const text = '\u{1f600}'.repeat(2000);
    const nonce = nextNonce();
    const result = await transport.sendSignedMessage(identity, room, nonce, text);

    expect(result.lane).toBe('post');
    expect([...result.text]).toHaveLength(2000);

    const record = result.page.messages.find((m) => m.from === identity.did);
    expect(record?.sig).toBeDefined();
    expect(
      verifyStoredMessage({
        room,
        nonce: record?.nonce as string,
        text: record?.text as string,
        did: record?.from as string,
        sig: record?.sig as string,
      }),
    ).toBe(true);
  });

  it('a tampered stored text stops verifying', async () => {
    const identity = Identity.create();
    const room = 'p-' + randomBytes(10).toString('hex');
    const nonce = nextNonce();
    const result = await transport.sendSignedMessage(identity, room, nonce, 'probe three');
    const record = result.page.messages.find((m) => m.from === identity.did);
    expect(
      verifyStoredMessage({
        room,
        nonce: record?.nonce as string,
        text: 'probe thref',
        did: record?.from as string,
        sig: record?.sig as string,
      }),
    ).toBe(false);
  });
});

describe.skipIf(!live)('live: cursor reads and long-polling', () => {
  const transport = new Transport();

  it('bootstraps, then follows a write through a long-poll', async () => {
    const identity = Identity.create();
    const room = 'p-' + randomBytes(10).toString('hex');

    // Seed the room so there is a cursor to open on. STATED [WAITING]: wait
    // only takes effect with a real since, so a follower needs one first.
    await transport.sendSignedMessage(identity, room, nextNonce(), 'seed');

    const { cursor, page } = await RoomCursor.open(transport, room);
    expect(page.count).toBeGreaterThan(0);
    expect(cursor.lastSeq).toBeGreaterThan(0n);

    // Write while a long-poll is in flight; the poll should return with it.
    const polling = cursor.poll({ waitSeconds: 10 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await transport.sendSignedMessage(identity, room, nextNonce(), 'arrives during the wait');

    const step = await polling;
    expect(step.kind).toBe('messages');
    if (step.kind !== 'messages') throw new Error('unreachable');
    expect(step.count).toBe(step.messages.length);
    expect(step.messages.some((m) => m.text === 'arrives during the wait')).toBe(true);
    // Contiguous with the cursor, so nothing was dropped.
    expect(step.gap).toBeNull();
  });

  it('holds a wait on a quiet room and reports it as quiet, not as not-held', async () => {
    const identity = Identity.create();
    const room = 'p-' + randomBytes(10).toString('hex');
    await transport.sendSignedMessage(identity, room, nextNonce(), 'seed');

    const { cursor } = await RoomCursor.open(transport, room);
    const started = Date.now();
    const step = await cursor.poll({ waitSeconds: 3 });
    const elapsed = Date.now() - started;

    // PROBED 2026-09-05: the server holds the request and reports wait_held
    // true. The elapsed time is approximate — observed overshoot of a second
    // or two is normal, so this asserts a floor rather than a window.
    expect(step.kind).toBe('quiet');
    expect(elapsed).toBeGreaterThan(2000);
  });

  it('reads the count off the reply rather than the limit it asked for', async () => {
    const identity = Identity.create();
    const room = 'p-' + randomBytes(10).toString('hex');
    for (const text of ['one', 'two', 'three']) {
      await transport.sendSignedMessage(identity, room, nextNonce(), text);
    }
    // STATED [PARAMETERS]: limit is clamped, never refused, and never echoed.
    const page = await transport.readRoomPage(room, { limit: 2 });
    expect(page.count).toBe(page.messages.length);
    expect(page.count).toBeLessThanOrEqual(3);
  });
});

describe.skipIf(!live)('live: limits are discovered, not assumed', () => {
  it('reads what this deployment enforces, which is not the documented default', async () => {
    // The reason limits.ts exists. The server's own config.py defaults are 120
    // and 30; technocore.chat runs five and ten times that. Asserting only the
    // relationship, not the numbers — a deployment may change either.
    const limits = await discoverLimits();
    expect(limits.readsPerMinutePerIp).toBeGreaterThan(0);
    expect(limits.writesPerMinutePerIp).toBeGreaterThan(0);
    expect(limits.source).toBe('agent.json');
  });

  it('agrees with /config, which publishes the same knobs by environment variable', async () => {
    const [limits, config] = await Promise.all([discoverLimits(), discoverConfig()]);
    expect(config.settings['rate_read']).toBe(limits.readsPerMinutePerIp);
    expect(config.settings['rate_write']).toBe(limits.writesPerMinutePerIp);
  });

  it('learns nothing about the budget from a JSON room read, and says so', async () => {
    // CONFIRMED IN SOURCE: respond() drops the footer for ?format=json. The
    // tracker must report unknown rather than inferring a full bucket.
    const transport = new Transport();
    const identity = Identity.create();
    const room = 'p-' + randomBytes(10).toString('hex');
    await transport.sendSignedMessage(identity, room, nextNonce(), 'budget probe');
    await transport.readRoomPage(room, { limit: 5 });
    expect(transport.budget.read.state).toBe('unknown');
  });
});

describe.skipIf(!live)('live: notes round-trip and compare-and-set', () => {
  const transport = new Transport();
  const notes = new Notes(transport);

  it('writes, reads back the exact value, and wins a CAS with it', async () => {
    const ns = 'p-' + randomBytes(10).toString('hex');

    expect(await notes.get(ns, 'state')).toBeNull();

    await notes.set(ns, 'state', 'step 4 done', { kind: 'ifAbsent' });

    const read = await notes.get(ns, 'state');
    expect(read?.value).toBe('step 4 done');
    // The banner really is served, and the value really is line index 2.
    expect(read?.banner.startsWith('!!')).toBe(true);
    expect(read?.raw.split('\n')[2]).toBe('step 4 done');

    // The extraction is correct if and only if this write lands.
    const ack = await notes.set(ns, 'state', 'step 5 done', {
      kind: 'ifValue',
      value: read?.value as string,
    });
    expect(ack.bytes).toBe('step 5 done'.length);

    expect((await notes.get(ns, 'state'))?.value).toBe('step 5 done');
  });

  it('loses a CAS against a stale value and rebases from the 409 body', async () => {
    const ns = 'p-' + randomBytes(10).toString('hex');
    await notes.set(ns, 'state', 'first', { kind: 'ifAbsent' });

    let caught: unknown;
    try {
      await notes.set(ns, 'state', 'never lands', { kind: 'ifValue', value: 'stale' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    const conflict = caught as ConflictError;
    expect(conflict.currentValue).toBe('first');
    expect(conflict.statedLength).toBe('first'.length);

    // Rebasing on the body alone, with no extra read.
    const ack = await notes.set(ns, 'state', 'second', {
      kind: 'ifValue',
      value: conflict.currentValue as string,
    });
    expect(ack.bytes).toBe('second'.length);
  });

  it('treats if_absent on an existing note as a lost race, not a bad request', async () => {
    const ns = 'p-' + randomBytes(10).toString('hex');
    await notes.set(ns, 'state', 'taken', { kind: 'ifAbsent' });
    await expect(
      notes.set(ns, 'state', 'mine', { kind: 'ifAbsent' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('treats an empty if= as a condition against the empty string', async () => {
    const ns = 'p-' + randomBytes(10).toString('hex');
    await notes.set(ns, 'state', 'not empty', { kind: 'ifAbsent' });
    // The note holds 'not empty', so a CAS against '' must lose rather than
    // being read as "no condition".
    await expect(
      notes.set(ns, 'state', 'x', { kind: 'ifValue', value: '' }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('lists what it wrote', async () => {
    const ns = 'p-' + randomBytes(10).toString('hex');
    await notes.set(ns, 'alpha', 'a');
    await notes.set(ns, 'beta', 'b');
    const keys = await notes.list(ns);
    expect([...keys].sort()).toEqual(['alpha', 'beta']);
  });
});
