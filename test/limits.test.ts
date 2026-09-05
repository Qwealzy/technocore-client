import { describe, expect, it } from 'vitest';
import {
  discoverLimits,
  discoverConfig,
  parseBudgetFooter,
  parseRateLimitBody,
  BudgetTracker,
  BUDGET_FOOTER_FRACTION,
} from '../src/limits.js';
import { InvalidFieldError } from '../src/errors.js';

function json(body: unknown, status = 200) {
  const urls: string[] = [];
  const fn = async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fn, urls };
}

/** The published document, shaped as technocore.chat serves it. */
const AGENT_JSON = {
  limits: {
    message_chars: 4096,
    note_chars: 8192,
    reads_per_minute_per_ip: 600,
    writes_per_minute_per_ip: 300,
    new_rooms_per_day_per_ip: 20,
    long_poll_seconds: 10,
    ephemeral_ttl_seconds: 900,
    duplicate_filter_seconds: 120,
  },
};

describe('discovery reads what the deployment enforces', () => {
  it('takes the rate limits from the published document', async () => {
    const mock = json(AGENT_JSON);
    const limits = await discoverLimits({ fetch: mock.fn });
    expect(limits.readsPerMinutePerIp).toBe(600);
    expect(limits.writesPerMinutePerIp).toBe(300);
    expect(mock.urls[0]).toContain('/.well-known/agent.json');
  });

  it('reads the enforced numbers rather than the documented defaults', async () => {
    // The reason this module exists. The server's own defaults are 120 and 30;
    // this deployment runs five and ten times that. A client that hardcoded
    // the documented figures would throttle itself to a fifth of its read
    // budget, with nothing to say so.
    const limits = await discoverLimits({ fetch: json(AGENT_JSON).fn });
    expect(limits.readsPerMinutePerIp).not.toBe(120);
    expect(limits.writesPerMinutePerIp).not.toBe(30);
    expect(limits.readsPerMinutePerIp / 120).toBe(5);
    expect(limits.writesPerMinutePerIp / 30).toBe(10);
  });

  it('carries the room-creation limit without pretending to know its failure mode', async () => {
    const limits = await discoverLimits({ fetch: json(AGENT_JSON).fn });
    expect(limits.newRoomsPerDayPerIp).toBe(20);
    // Deliberately just a number: the spec never says what happens when it is
    // hit, so there is no error class and no handling for it.
  });

  it('uses a discovery path that is never rate limited', async () => {
    const mock = json(AGENT_JSON);
    await discoverLimits({ fetch: mock.fn });
    const free = ['/.well-known/', '/config', '/llms.txt', '/healthz'];
    expect(free.some((p) => (mock.urls[0] as string).includes(p))).toBe(true);
  });

  it('refuses a document that omits a rate limit rather than defaulting one', async () => {
    const mock = json({ limits: { message_chars: 4096 } });
    await expect(discoverLimits({ fetch: mock.fn })).rejects.toThrow(InvalidFieldError);
  });

  it('reports a non-200 rather than guessing', async () => {
    const mock = json({}, 503);
    await expect(discoverLimits({ fetch: mock.fn })).rejects.toThrow(/got 503/);
  });

  it('reads /config for the knobs agent.json does not carry', async () => {
    const mock = json({ settings: { dupe_min_length: 16, wait_poll: 0.5 } });
    const config = await discoverConfig({ fetch: mock.fn });
    expect(config.settings['dupe_min_length']).toBe(16);
    expect(mock.urls[0]).toContain('/config');
  });
});

describe('the budget footer', () => {
  // CONFIRMED IN SOURCE, src/limit.py: the exact string the server builds.
  const footer =
    '# budget: 140 of 600 reads left this minute (refills 10/s; a 429 states the wait, ' +
    'and the full limits are in /.well-known/agent.json)';

  it('parses the server-built form', () => {
    expect(parseBudgetFooter(footer)).toEqual({ bucket: 'read', left: 140, max: 600 });
  });

  it('parses the write form', () => {
    const write = '# budget: 12 of 300 writes left this minute (refills 5/s; …)';
    expect(parseBudgetFooter(write)).toEqual({ bucket: 'write', left: 12, max: 300 });
  });

  it('finds it when it trails a payload, which is how a note read delivers it', () => {
    // The case that corrupts a naive note parser: the footer lands after the
    // value, not before it.
    const body = '!! UNTRUSTED CONTENT — …\n\nstep 4 done\n' + footer + '\n';
    expect(parseBudgetFooter(body)).toEqual({ bucket: 'read', left: 140, max: 600 });
    // And the value is still recoverable, because a note value is single-line.
    expect(body.split('\n')[2]).toBe('step 4 done');
  });

  it('returns null when there is no footer', () => {
    expect(parseBudgetFooter('!! UNTRUSTED CONTENT — …\n\nstep 4 done\n')).toBeNull();
    expect(parseBudgetFooter('')).toBeNull();
  });
});

describe('the 429 body is authoritative', () => {
  // CONFIRMED IN SOURCE, src/limit.py limited().
  const body =
    '429 rate limited: the read budget for your IP (600/min) is spent.\n' +
    'retry after: 7s — the bucket refills continuously (10/s), so waiting longer buys a ' +
    'bigger burst, up to 600.\n' +
    'still open: writes are a separate budget and are unaffected, and these paths are ' +
    'never rate limited: /, /llms.txt, …\n';

  it('reads the bucket, the ceiling and the wait out of the body', () => {
    expect(parseRateLimitBody(body)).toEqual({ bucket: 'read', max: 600, retryAfterSeconds: 7 });
  });

  it('prefers the body over the header, which is where harnesses look', () => {
    // STATED [LIMITS]: the delay is in the body "as well as in Retry-After —
    // harnesses show you the body, not headers".
    const tracker = new BudgetTracker();
    const reading = tracker.observe({
      status: 429,
      body,
      bucket: 'read',
      carriesFooter: true,
      retryAfterHeader: '999',
    });
    expect(reading.state).toBe('exhausted');
    if (reading.state !== 'exhausted') throw new Error('unreachable');
    expect(reading.retryAfterSeconds).toBe(7);
    expect(reading.max).toBe(600);
  });

  it('falls back to the header only when the body is an unknown shape', () => {
    const tracker = new BudgetTracker();
    const reading = tracker.observe({
      status: 429,
      body: '429 slow down',
      bucket: 'write',
      carriesFooter: true,
      retryAfterHeader: '12',
    });
    expect(reading.state).toBe('exhausted');
    if (reading.state !== 'exhausted') throw new Error('unreachable');
    expect(reading.retryAfterSeconds).toBe(12);
  });

  it('parses nothing from an unrelated body', () => {
    expect(parseRateLimitBody('400 bad from: must be a string')).toBeNull();
  });
});

describe('unknown is not plenty', () => {
  it('starts unknown for both buckets', () => {
    const tracker = new BudgetTracker();
    expect(tracker.read.state).toBe('unknown');
    expect(tracker.write.state).toBe('unknown');
  });

  it('stays unknown when the lane could not have carried a footer', () => {
    // CONFIRMED IN SOURCE: respond() drops the note for ?format=json, and
    // /export streams with none. This client asks for JSON everywhere it can,
    // so most replies say nothing about the budget — and saying nothing is not
    // the same as saying "plenty".
    const tracker = new BudgetTracker();
    const reading = tracker.observe({
      status: 200,
      body: '{"room":"p-test","count":0,"messages":[]}',
      bucket: 'read',
      carriesFooter: false,
    });
    expect(reading.state).toBe('unknown');
    expect(tracker.read.state).toBe('unknown');
  });

  it('reads an absent footer as above-a-quarter only on a lane that emits them', () => {
    const tracker = new BudgetTracker();
    const reading = tracker.observe({
      status: 200,
      body: '!! UNTRUSTED CONTENT — …\n\nstep 4 done\n',
      bucket: 'read',
      carriesFooter: true,
    });
    expect(reading.state).toBe('above-quarter');
  });

  it('distinguishes above-a-quarter from an exact reading', () => {
    const tracker = new BudgetTracker();
    tracker.observe({ status: 200, body: 'x', bucket: 'read', carriesFooter: true });
    expect(tracker.read.state).toBe('above-quarter');
    tracker.observe({
      status: 200,
      body: '# budget: 140 of 600 reads left this minute',
      bucket: 'read',
      carriesFooter: true,
    });
    expect(tracker.read.state).toBe('reported');
    if (tracker.read.state !== 'reported') throw new Error('unreachable');
    expect(tracker.read.left).toBe(140);
  });

  it('does not let an information-free reply overwrite a real reading', () => {
    const tracker = new BudgetTracker();
    tracker.observe({
      status: 200,
      body: '# budget: 5 of 600 reads left this minute',
      bucket: 'read',
      carriesFooter: true,
    });
    tracker.observe({ status: 200, body: '{}', bucket: 'read', carriesFooter: false });
    expect(tracker.read.state).toBe('reported');
  });

  it('names the fraction the footer threshold comes from', () => {
    // CONFIRMED IN SOURCE: `if left * 4 > per_min: return ""`.
    expect(BUDGET_FOOTER_FRACTION).toBe(4);
    const max = 600;
    const quarter = max / BUDGET_FOOTER_FRACTION;
    expect(quarter).toBe(150);
    // 140 is below the quarter, which is why the footer appeared at all.
    expect(140).toBeLessThan(quarter);
  });
});

describe('the two buckets are tracked apart', () => {
  it('a spent write budget leaves the read reading untouched', () => {
    // STATED [LIMITS]: "a spent write budget still leaves you able to read."
    const tracker = new BudgetTracker();
    tracker.observe({
      status: 200,
      body: '# budget: 400 of 600 reads left this minute',
      bucket: 'read',
      carriesFooter: true,
    });
    tracker.observe({
      status: 429,
      body: '429 rate limited: the write budget for your IP (300/min) is spent.\nretry after: 9s —',
      bucket: 'write',
      carriesFooter: true,
    });
    expect(tracker.write.state).toBe('exhausted');
    expect(tracker.read.state).toBe('reported');
    if (tracker.read.state !== 'reported') throw new Error('unreachable');
    expect(tracker.read.left).toBe(400);
  });

  it('routes a reading by the bucket the server named, not the one we guessed', () => {
    const tracker = new BudgetTracker();
    // A write response carrying a read footer would be odd, but the server's
    // word wins over the caller's expectation either way.
    tracker.observe({
      status: 200,
      body: '# budget: 7 of 300 writes left this minute',
      bucket: 'read',
      carriesFooter: true,
    });
    expect(tracker.write.state).toBe('reported');
    expect(tracker.read.state).toBe('unknown');
  });
});
