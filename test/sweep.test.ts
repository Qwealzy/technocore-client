import { describe, expect, it } from 'vitest';
import { sweep, isEmptyAfterSweep } from '../src/sweep.js';

describe('sweep - hand-computed cases', () => {
  // These three separate a correct sweep from the three plausible wrong ones:
  // delete-instead-of-substitute, collapse-runs, and trim-before-substitute.
  it('substitutes rather than deletes', () => {
    expect(sweep('a\u0000b')).toBe('a b');
    expect(sweep('a\u0000b')).toHaveLength(3);
  });

  it('does not collapse runs', () => {
    expect(sweep('a\u200d\u200db')).toBe('a  b');
    expect(sweep('a\u200d\u200db')).toHaveLength(4);
  });

  it('leaves nothing when the whole text is sweepable', () => {
    expect(sweep('\u200d\u200d')).toBe('');
    // STATED [openapi 400]: the server refuses a text left empty by the sweep.
    expect(isEmptyAfterSweep('\u200d\u200d')).toBe(true);
  });
});

describe('sweep - the six categories the spec names', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['Cc - C0 control (BEL)', '\u0007'],
    ['Cc - newline', '\n'],
    ['Cc - carriage return', '\r'],
    ['Cc - C1 control (NEL)', '\u0085'],
    ['Cf - zero-width joiner', '\u200d'],
    ['Cf - right-to-left override', '\u202e'],
    ['Cf - byte order mark', '\ufeff'],
    ['Cf - Unicode tag block', '\u{e0041}'],
    ['Co - BMP private use', '\ue000'],
    ['Co - plane 15 private use', '\u{f0000}'],
    ['Cs - lone high surrogate', '\ud800'],
    ['Cs - lone low surrogate', '\udc00'],
    ['Zl - line separator', '\u2028'],
    ['Zp - paragraph separator', '\u2029'],
  ];

  for (const [label, char] of cases) {
    it('replaces ' + label + ' with a space', () => {
      expect(sweep('a' + char + 'b')).toBe('a b');
    });
  }
});

describe('sweep - what it must NOT touch', () => {
  it('keeps astral characters, which are a surrogate pair, not lone Cs', () => {
    expect(sweep('a\u{1f600}b')).toBe('a\u{1f600}b');
    expect(sweep('a\u{1f600}b')).toHaveLength(4);
  });

  it('keeps interior Zs characters, which the spec does not list', () => {
    // Zs is absent from the spec's Cc/Cf/Cs/Co/Zl/Zp list. Sweeping it would
    // produce bytes the server never stores, and a signature over those bytes
    // would not verify.
    expect(sweep('a\u00a0b')).toBe('a\u00a0b');
    expect(sweep('a\u3000b')).toBe('a\u3000b');
  });

  it('keeps the pipe character, which also appears in the signature payload', () => {
    expect(sweep('a|b')).toBe('a|b');
  });

  it('does not normalise', () => {
    // STATED [NORMALIZATION]: "the server never normalizes ... NFC and NFD of
    // one word are two different messages here."
    const nfc = 'Vi\u1ec7t';
    const nfd = 'Vi\u0065\u0323\u0302t';
    expect(sweep(nfc)).toBe(nfc);
    expect(sweep(nfd)).toBe(nfd);
    expect(sweep(nfc)).not.toBe(sweep(nfd));
  });

  it('leaves ordinary text alone', () => {
    expect(sweep('hello world')).toBe('hello world');
  });
});

describe('sweep - ordering and idempotence', () => {
  it('trims after substituting, not before', () => {
    // If trim ran first the controls would still be at the ends, become
    // spaces, and leave " a ".
    expect(sweep('\u0000a\u0000')).toBe('a');
  });

  it('is idempotent, so a stored text sweeps to itself', () => {
    for (const input of ['a\u0000b', '\u0000x\u0000', 'a\u200d\u200db', 'plain']) {
      expect(sweep(sweep(input))).toBe(sweep(input));
    }
  });
});
