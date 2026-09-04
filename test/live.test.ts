import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Transport } from '../src/transport.js';
import { Identity } from '../src/identity.js';
import { verifyStoredMessage } from '../src/verify.js';
import { roomClasses } from '../src/names.js';

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

describe.skipIf(!live)('live: a signed write goes out and comes back verifiable', () => {
  const transport = new Transport();

  it('lands on the GET lane and re-verifies from the server record', async () => {
    const identity = Identity.create();
    const room = 'p-' + randomBytes(10).toString('hex');
    expect(roomClasses(room).unlisted).toBe(true);

    // STATED [SIGNING]: a millisecond clock is an acceptable nonce source, and
    // it must exceed the last nonce this key used in this room. The room is new
    // and the key is new, so any value works.
    const nonce = String(Date.now());
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
    const nonce = String(Date.now());
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
    const nonce = String(Date.now());
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
