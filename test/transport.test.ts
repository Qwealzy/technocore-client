import { describe, expect, it } from 'vitest';
import { Transport, parseRoomPage, SPEC_STATED_URL_BUDGET_BYTES } from '../src/transport.js';
import { Identity } from '../src/identity.js';
import { roomName } from '../src/names.js';
import { verifyStoredMessage } from '../src/verify.js';
import {
  InvalidFieldError,
  DuplicateRefusedError,
  RateLimitedError,
  LaneRefusedError,
  ConflictError,
  BadFieldError,
  NotFoundError,
  PayloadTooLargeError,
  HeadersTooLargeError,
  UnexpectedStatusError,
  UrlTooLongError,
} from '../src/errors.js';

/** A fetch that returns one canned response and records what it was called with. */
function mockFetch(
  status: number,
  body: string,
  responseHeaders: Record<string, string> = { 'content-type': 'application/json' },
) {
  const calls: { url: string; init?: unknown }[] = [];
  const fn = async (url: string, init?: unknown) => {
    calls.push({ url, init });
    return new Response(body, { status, headers: responseHeaders });
  };
  return { fn, calls };
}

function pageJson(messages: unknown[] = []): string {
  return JSON.stringify({
    room: 'p-test',
    count: messages.length,
    first_seq: 1,
    last_seq: messages.length,
    generation: 0,
    messages,
  });
}

describe('lane selection measures the encoded URL', () => {
  const identity = Identity.create();
  const room = roomName('p-test');

  it('uses the GET lane for text that fits', () => {
    const transport = new Transport();
    const signed = identity.signMessage(room, '1', 'hello');
    const decision = transport.selectSignedMessageLane(
      room,
      signed.did,
      signed.sig,
      signed.nonce,
      signed.text,
    );
    expect(decision.lane).toBe('get');
    expect(decision.urlBytes).toBe(Buffer.byteLength(decision.url, 'utf8'));
    expect(decision.urlBytes).toBeLessThan(decision.maxUrlBytes);
  });

  it('switches to POST when the encoded URL exceeds the budget', () => {
    const transport = new Transport();
    const signed = identity.signMessage(room, '1', 'a'.repeat(4096));
    const short = transport.selectSignedMessageLane(
      room,
      signed.did,
      signed.sig,
      signed.nonce,
      'a'.repeat(100),
    );
    const long = transport.selectSignedMessageLane(
      room,
      signed.did,
      signed.sig,
      signed.nonce,
      'a'.repeat(SPEC_STATED_URL_BUDGET_BYTES),
    );
    expect(short.lane).toBe('get');
    expect(long.lane).toBe('post');
  });

  it('decides by bytes, not by character count', () => {
    // STATED [URL BUDGET]: percent-encoding costs 3 bytes per UTF-8 byte, so
    // one ASCII character is 1 byte and an emoji is 12. These two texts have
    // the same character count and land on different lanes.
    const transport = new Transport({ maxUrlBytes: 2000 });
    const signed = identity.signMessage(room, '1', 'x');
    const ascii = transport.selectSignedMessageLane(room, signed.did, signed.sig, '1', 'a'.repeat(600));
    const emoji = transport.selectSignedMessageLane(
      room,
      signed.did,
      signed.sig,
      '1',
      '\u{1f600}'.repeat(600),
    );
    expect([...'a'.repeat(600)].length).toBe([...'\u{1f600}'.repeat(600)].length);
    expect(ascii.lane).toBe('get');
    expect(emoji.lane).toBe('post');
    expect(emoji.urlBytes).toBeGreaterThan(ascii.urlBytes * 5);
  });

  it('does not treat Latin script as automatically cheap', () => {
    // STATED [URL BUDGET]: "That is not the Latin/non-Latin line it looks like:
    // dense Vietnamese and dense Polish are Latin and both blow the budget."
    const transport = new Transport({ maxUrlBytes: 3000 });
    const signed = identity.signMessage(room, '1', 'x');
    const polish = transport.selectSignedMessageLane(
      room,
      signed.did,
      signed.sig,
      '1',
      ' acelnoszz'.repeat(90),
    );
    const densePolish = transport.selectSignedMessageLane(
      room,
      signed.did,
      signed.sig,
      '1',
      'ąćęłńóśźż'.repeat(90),
    );
    expect(polish.lane).toBe('get');
    expect(densePolish.lane).toBe('post');
  });

  it('reports the budget it used, so the decision is inspectable', () => {
    const transport = new Transport({ maxUrlBytes: 500 });
    const signed = identity.signMessage(room, '1', 'hi');
    const decision = transport.selectSignedMessageLane(room, signed.did, signed.sig, '1', 'hi');
    expect(decision.maxUrlBytes).toBe(500);
  });
});

describe('signed write', () => {
  const identity = Identity.create();

  it('sends the swept text, not the text it was given', async () => {
    const mock = mockFetch(200, pageJson());
    const transport = new Transport({ fetch: mock.fn });
    const result = await transport.sendSignedMessage(identity, 'p-test', '1', '  a\u0000b  ');
    expect(result.text).toBe('a b');
    expect(mock.calls[0]?.url).toContain(encodeURIComponent('a b'));
    expect(mock.calls[0]?.url).not.toContain('%00');
  });

  it('signs the swept text, so the record verifies', async () => {
    const mock = mockFetch(200, pageJson());
    const transport = new Transport({ fetch: mock.fn });
    const result = await transport.sendSignedMessage(identity, 'p-test', '7', ' hel lo ');
    expect(
      verifyStoredMessage({
        room: 'p-test',
        nonce: result.nonce,
        text: result.text,
        did: result.did,
        sig: result.sig,
      }),
    ).toBe(true);
  });

  it('sends the nonce as a string on the POST lane', async () => {
    const mock = mockFetch(200, pageJson());
    const transport = new Transport({ fetch: mock.fn, maxUrlBytes: 200 });
    const nonce = '9223372036854775807';
    await transport.sendSignedMessage(identity, 'p-test', nonce, 'x'.repeat(300));
    const init = mock.calls[0]?.init as { method: string; body: string };
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body['nonce']).toBe(nonce);
    expect(typeof body['nonce']).toBe('string');
    // The digits survive; JSON.parse of a bare number would not.
    expect(String(body['nonce'])).toBe(nonce);
  });

  it('validates semantic parameters before spending a request', async () => {
    const mock = mockFetch(200, pageJson());
    const transport = new Transport({ fetch: mock.fn });
    await expect(transport.sendSignedMessage(identity, 'NOT VALID', '1', 'hi')).rejects.toThrow(
      InvalidFieldError,
    );
    await expect(transport.sendSignedMessage(identity, 'p-test', 'abc', 'hi')).rejects.toThrow(
      /bad nonce/,
    );
    await expect(transport.sendSignedMessage(identity, 'p-test', '1', '   ')).rejects.toThrow(
      /empty after the single-line sweep/,
    );
    expect(mock.calls).toHaveLength(0);
  });

  it('does not retry anything', async () => {
    for (const status of [403, 422, 429, 409]) {
      const mock = mockFetch(status, 'refused', { 'content-type': 'text/plain' });
      const transport = new Transport({ fetch: mock.fn });
      await expect(transport.sendSignedMessage(identity, 'p-test', '1', 'hi')).rejects.toThrow();
      expect(mock.calls).toHaveLength(1);
    }
  });
});

describe('every error class reaches the caller from a mocked response', () => {
  const identity = Identity.create();
  // `lane` says which lane the case must be exercised on. 413 belongs on POST:
  // STATED, it is the 256 KiB body cap, and a GET carries no body, so a 413
  // answering a GET is the edge complaining about the URL instead, which is a
  // different class entirely (see the URL-budget suite below).
  const cases: readonly (readonly [number, string, new (...args: never[]) => Error, 'get' | 'post'])[] =
    [
      [400, '400 bad text: must be a string', BadFieldError, 'get'],
      [403, '403 mailbox takes signed writes only', LaneRefusedError, 'get'],
      [404, '404 no route matched', NotFoundError, 'get'],
      [409, '409 note ns/key changed since you read it', ConflictError, 'get'],
      [413, '413 body over 262144 bytes', PayloadTooLargeError, 'post'],
      [422, '422 duplicate', DuplicateRefusedError, 'get'],
      [429, '429 wait 5 seconds', RateLimitedError, 'get'],
      [431, '431 header block too large', HeadersTooLargeError, 'get'],
      [503, 'Service Unavailable', UnexpectedStatusError, 'get'],
    ];

  for (const [status, body, expected, lane] of cases) {
    it('surfaces ' + status + ' on the ' + lane.toUpperCase() + ' lane as ' + expected.name, async () => {
      const mock = mockFetch(status, body, { 'content-type': 'text/plain' });
      // A budget of 1 byte forces every write onto the POST lane.
      const transport = new Transport(
        lane === 'post' ? { fetch: mock.fn, maxUrlBytes: 1 } : { fetch: mock.fn },
      );
      await expect(
        transport.sendSignedMessage(identity, 'p-test', '1', 'hi'),
      ).rejects.toBeInstanceOf(expected);
    });
  }
});

describe('format is advisory, so the reply is checked not assumed', () => {
  it('refuses to parse a 200 that came back as text/plain', async () => {
    // STATED [PARAMETERS]: "any format other than the literal json leaves the
    // reply as text/plain ... Read count and Content-Type off the reply rather
    // than assuming the value you sent survived."
    const mock = mockFetch(200, '# room p-test  messages 1', { 'content-type': 'text/plain' });
    const transport = new Transport({ fetch: mock.fn });
    await expect(transport.readRoomPage('p-test')).rejects.toThrow(/expected application\/json/);
  });
});

describe('advisory parameters are omitted when absent', () => {
  it('sends no limit when none was given', async () => {
    const mock = mockFetch(200, pageJson());
    const transport = new Transport({ fetch: mock.fn });
    await transport.readRoomPage('p-test');
    expect(mock.calls[0]?.url).not.toContain('limit=');
    expect(mock.calls[0]?.url).toContain('format=json');
  });

  it('sends a limit when one was given', async () => {
    const mock = mockFetch(200, pageJson());
    const transport = new Transport({ fetch: mock.fn });
    await transport.readRoomPage('p-test', { limit: 5 });
    expect(mock.calls[0]?.url).toContain('limit=5');
  });
});

describe('big integers survive parsing', () => {
  it('keeps a 19-digit nonce exact', () => {
    // STATED [EXPORT]: "a float-rounded nonce fails good signatures".
    const nonce = '9223372036854775807';
    const raw = JSON.stringify({
      room: 'p-test',
      count: 1,
      first_seq: 1,
      last_seq: 1,
      generation: 0,
      messages: [{ seq: 1, ts: 't', from: 'did:key:z', text: 'hi', nonce: 1 }],
    }).replace('"nonce":1', '"nonce":' + nonce);
    const page = parseRoomPage(raw);
    expect(page.messages[0]?.nonce).toBe(nonce);
    expect(Number(nonce).toString()).not.toBe(nonce);
  });

  it('keeps a seq past 2^53 exact, so a cursor cannot drift', () => {
    const seq = '9007199254740993';
    const raw = JSON.stringify({
      room: 'p-test',
      count: 1,
      first_seq: 1,
      last_seq: 1,
      generation: 0,
      messages: [{ seq: 1, ts: 't', from: 'n', text: 'hi' }],
    })
      .replace('"seq":1', '"seq":' + seq)
      .replace('"last_seq":1', '"last_seq":' + seq);
    const page = parseRoomPage(raw);
    expect(page.messages[0]?.seq).toBe(BigInt(seq));
    expect(page.lastSeq).toBe(BigInt(seq));
  });

  it('does not rewrite digits that appear inside a message text', () => {
    // The rewrite must key on real JSON keys, not on the characters. A message
    // whose text contains JSON is exactly the input that breaks a naive regex.
    const text = '{"seq": 999, "nonce": 12345}';
    const raw = JSON.stringify({
      room: 'p-test',
      count: 1,
      first_seq: 1,
      last_seq: 1,
      generation: 0,
      messages: [{ seq: 4, ts: 't', from: 'n', text }],
    });
    const page = parseRoomPage(raw);
    expect(page.messages[0]?.text).toBe(text);
    expect(page.messages[0]?.seq).toBe(4n);
  });

  it('omits sig rather than setting it to undefined', () => {
    // STATED [RENDERING]: a missing sig means "not re-verifiable", not
    // "invalid". The absence should be visible.
    const raw = pageJson([{ seq: 1, ts: 't', from: 'nick', text: 'hi' }]);
    const page = parseRoomPage(raw);
    expect('sig' in (page.messages[0] as object)).toBe(false);
  });

  it('reads wait_held when present and null when absent', () => {
    expect(parseRoomPage(pageJson()).waitHeld).toBeNull();
    const withFlag = JSON.parse(pageJson()) as Record<string, unknown>;
    withFlag['wait_held'] = false;
    expect(parseRoomPage(JSON.stringify(withFlag)).waitHeld).toBe(false);
  });
});

describe('the transport learns its edge budget downward', () => {
  const identity = Identity.create();

  /** A fetch that refuses long GET URLs the way an edge would, and accepts POST. */
  function edge(realCeiling: number, refusalStatus = 414) {
    const calls: { url: string; method: string; bytes: number }[] = [];
    const fn = async (url: string, init?: { method?: string }) => {
      const method = init?.method ?? 'GET';
      const bytes = Buffer.byteLength(url, 'utf8');
      calls.push({ url, method, bytes });
      if (method === 'GET' && bytes > realCeiling) {
        return new Response('414 URI Too Long', {
          status: refusalStatus,
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response(pageJson(), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    return { fn, calls };
  }

  it('reports a URL-length refusal as its own typed error, naming the length', async () => {
    const mock = edge(1000);
    const transport = new Transport({ fetch: mock.fn, maxUrlBytes: 16384 });
    let caught: unknown;
    try {
      await transport.sendSignedMessage(identity, 'p-test', '1', 'x'.repeat(2000));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UrlTooLongError);
    const error = caught as UrlTooLongError;
    expect(error.status).toBe(414);
    expect(error.urlBytes).toBeGreaterThan(1000);
    expect(error.message).toContain('POST lane');
    expect(error.message).toContain(String(error.urlBytes));
  });

  it('does not retry; the caller decides', async () => {
    const mock = edge(1000);
    const transport = new Transport({ fetch: mock.fn, maxUrlBytes: 16384 });
    await expect(
      transport.sendSignedMessage(identity, 'p-test', '1', 'x'.repeat(2000)),
    ).rejects.toBeInstanceOf(UrlTooLongError);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.method).toBe('GET');
  });

  it('lowers the budget below the refused length, so the same wall is not hit twice', async () => {
    const mock = edge(1000);
    const transport = new Transport({ fetch: mock.fn, maxUrlBytes: 16384 });
    const text = 'x'.repeat(2000);

    await expect(transport.sendSignedMessage(identity, 'p-test', '1', text)).rejects.toBeInstanceOf(
      UrlTooLongError,
    );
    const refusedAt = transport.urlBudget.smallestRejected as number;
    expect(transport.urlBudget.effective).toBe(refusedAt - 1);
    expect(transport.urlBudget.configured).toBe(16384);

    // The identical write now goes down the POST lane without asking the edge.
    const result = await transport.sendSignedMessage(identity, 'p-test', '2', text);
    expect(result.lane).toBe('post');
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]?.method).toBe('POST');
  });

  it('keeps the shortest refusal and the longest acceptance', async () => {
    const mock = edge(1200);
    const transport = new Transport({ fetch: mock.fn, maxUrlBytes: 16384 });
    await transport.sendSignedMessage(identity, 'p-test', '1', 'x'.repeat(400));
    const accepted = transport.urlBudget.largestAccepted as number;
    expect(accepted).toBeGreaterThan(0);

    await expect(
      transport.sendSignedMessage(identity, 'p-test', '2', 'x'.repeat(5000)),
    ).rejects.toBeInstanceOf(UrlTooLongError);
    const firstRejection = transport.urlBudget.smallestRejected as number;

    await expect(
      transport.sendSignedMessage(identity, 'p-test', '3', 'x'.repeat(1400)),
    ).rejects.toBeInstanceOf(UrlTooLongError);
    expect(transport.urlBudget.smallestRejected).toBeLessThan(firstRejection);
    expect(transport.urlBudget.largestAccepted).toBe(accepted);
    // The real ceiling is known to lie between the two observations.
    expect(transport.urlBudget.largestAccepted as number).toBeLessThan(
      transport.urlBudget.smallestRejected as number,
    );
  });

  it('treats a 413 on the GET lane as a URL refusal, not the POST body cap', async () => {
    // The spec's 413 is the 256 KiB POST body cap, which a GET with no body
    // cannot have hit. Some edges answer an over-long request line with 413.
    const mock = edge(1000, 413);
    const transport = new Transport({ fetch: mock.fn, maxUrlBytes: 16384 });
    await expect(
      transport.sendSignedMessage(identity, 'p-test', '1', 'x'.repeat(2000)),
    ).rejects.toBeInstanceOf(UrlTooLongError);
  });

  it('still reports a 413 on the POST lane as the body cap', async () => {
    const mock = mockFetch(413, '413 body over 262144 bytes', { 'content-type': 'text/plain' });
    const transport = new Transport({ fetch: mock.fn, maxUrlBytes: 100 });
    let caught: unknown;
    try {
      await transport.sendSignedMessage(identity, 'p-test', '1', 'x'.repeat(500));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PayloadTooLargeError);
    expect(caught).not.toBeInstanceOf(UrlTooLongError);
  });

  it('keeps the observation on one instance and never widens it', async () => {
    const mock = edge(1000);
    const learned = new Transport({ fetch: mock.fn, maxUrlBytes: 16384 });
    await expect(
      learned.sendSignedMessage(identity, 'p-test', '1', 'x'.repeat(2000)),
    ).rejects.toBeInstanceOf(UrlTooLongError);
    expect(learned.urlBudget.effective).toBeLessThan(16384);

    // A second transport knows nothing: this is an observation, not a limit,
    // and it is never written anywhere.
    const fresh = new Transport({ fetch: mock.fn, maxUrlBytes: 16384 });
    expect(fresh.urlBudget.effective).toBe(16384);
    expect(fresh.urlBudget.smallestRejected).toBeNull();

    // A later success at a shorter length does not raise the budget back up.
    const effectiveAfterRefusal = learned.urlBudget.effective;
    await learned.sendSignedMessage(identity, 'p-test', '2', 'x'.repeat(100));
    expect(learned.urlBudget.effective).toBe(effectiveAfterRefusal);
  });

  it('leaves other statuses on the GET lane alone', async () => {
    for (const [status, expected] of [
      [422, DuplicateRefusedError],
      [429, RateLimitedError],
    ] as const) {
      const mock = mockFetch(status, 'refused', { 'content-type': 'text/plain' });
      const transport = new Transport({ fetch: mock.fn });
      await expect(
        transport.sendSignedMessage(identity, 'p-test', '1', 'hi'),
      ).rejects.toBeInstanceOf(expected);
      expect(transport.urlBudget.smallestRejected).toBeNull();
    }
  });
});

describe('a generic 400 on the GET lane may be an edge, not a parameter', () => {
  const identity = Identity.create();

  // STATED [PARAMETERS]: the application's 400 "names the field", e.g.
  // "400 bad from: must be a string". Some edges answer an over-long request
  // line with 400 instead of 414, which collides with that. The two want
  // opposite recoveries, so the possibility is raised, and nothing more.
  const APPLICATION_400 = '400 bad text: must be a string\n';
  const EDGE_400 = '<html><head><title>400 Bad Request</title></head><body></body></html>';

  it('says nothing extra when the body names a field', async () => {
    const mock = mockFetch(400, APPLICATION_400, { 'content-type': 'text/plain' });
    const transport = new Transport({ fetch: mock.fn });
    let caught: unknown;
    try {
      await transport.sendSignedMessage(identity, 'p-test', '1', 'x'.repeat(12000));
    } catch (error) {
      caught = error;
    }
    const error = caught as BadFieldError;
    expect(error).toBeInstanceOf(BadFieldError);
    expect(error.field).toBe('text');
    expect(error.mayBeEdgeRejection).toBe(false);
    expect(error.message).not.toContain('edge');
  });

  it('says nothing extra for a short URL, whatever the body looks like', async () => {
    // Below the length RFC 7230 recommends every implementation support, an
    // edge rejecting on length would be violating that recommendation, so
    // raising it would be noise.
    const mock = mockFetch(400, EDGE_400, { 'content-type': 'text/html' });
    const transport = new Transport({ fetch: mock.fn });
    let caught: unknown;
    try {
      await transport.sendSignedMessage(identity, 'p-test', '1', 'hi');
    } catch (error) {
      caught = error;
    }
    const error = caught as BadFieldError;
    expect(error).toBeInstanceOf(BadFieldError);
    expect(error.mayBeEdgeRejection).toBe(false);
  });

  it('raises the possibility for a generic body on a long GET write', async () => {
    const mock = mockFetch(400, EDGE_400, { 'content-type': 'text/html' });
    const transport = new Transport({ fetch: mock.fn });
    let caught: unknown;
    try {
      await transport.sendSignedMessage(identity, 'p-test', '1', 'x'.repeat(12000));
    } catch (error) {
      caught = error;
    }
    const error = caught as BadFieldError;
    expect(error).toBeInstanceOf(BadFieldError);
    expect(error.mayBeEdgeRejection).toBe(true);
    expect(error.field).toBeNull();
    expect(error.message).toContain('edge');
    expect(error.message).toContain('POST lane');
  });

  it('does not reclassify, retry, or narrow the budget', async () => {
    const mock = mockFetch(400, EDGE_400, { 'content-type': 'text/html' });
    const transport = new Transport({ fetch: mock.fn });
    await expect(
      transport.sendSignedMessage(identity, 'p-test', '1', 'x'.repeat(12000)),
    ).rejects.toBeInstanceOf(BadFieldError);
    // Still a 400, still one request, and the budget is untouched: a suspicion
    // is not an observation.
    expect(mock.calls).toHaveLength(1);
    expect(transport.urlBudget.smallestRejected).toBeNull();
    expect(transport.urlBudget.effective).toBe(transport.urlBudget.configured);
  });

  it('goes quiet once the edge has accepted a URL that long', async () => {
    // Evidence beats suspicion: if 12000 bytes already worked, a later 400 at
    // that size is about the parameters.
    const calls: string[] = [];
    let status = 200;
    const fn = async (url: string) => {
      calls.push(url);
      return status === 200
        ? new Response(pageJson(), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(EDGE_400, { status: 400, headers: { 'content-type': 'text/html' } });
    };
    const transport = new Transport({ fetch: fn });
    await transport.sendSignedMessage(identity, 'p-test', '1', 'x'.repeat(12000));
    expect(transport.urlBudget.largestAccepted).toBeGreaterThan(12000);

    status = 400;
    let caught: unknown;
    try {
      await transport.sendSignedMessage(identity, 'p-test', '2', 'x'.repeat(11000));
    } catch (error) {
      caught = error;
    }
    expect((caught as BadFieldError).mayBeEdgeRejection).toBe(false);
  });

  it('leaves a 400 on the POST lane alone', async () => {
    // The hint is about the request line, which a POST body is not.
    const mock = mockFetch(400, EDGE_400, { 'content-type': 'text/html' });
    const transport = new Transport({ fetch: mock.fn, maxUrlBytes: 1 });
    let caught: unknown;
    try {
      await transport.sendSignedMessage(identity, 'p-test', '1', 'x'.repeat(12000));
    } catch (error) {
      caught = error;
    }
    expect((caught as BadFieldError).mayBeEdgeRejection).toBe(false);
  });
});
