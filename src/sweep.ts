/**
 * The single-line sweep.
 *
 * STATED [SINGLE LINE]: "Every character in Unicode general categories Cc, Cf,
 * Cs, Co, Zl and Zp is replaced with a space before storage, then the ends are
 * trimmed."
 *
 * Three things about that sentence do the damage, and each is a separate bug if
 * you get it wrong:
 *   1. REPLACED, not deleted. "a\u0000b" stores as "a b" — three characters.
 *   2. No run collapsing. Two swept characters become two spaces, not one.
 *   3. Trim happens AFTER substitution, so a text of only sweepable characters
 *      collapses to spaces and then to the empty string.
 *
 * STATED [SIGNING]: the signature covers the text after this runs. Sweep before
 * signing, never after — see payload.ts, which is the only supported way to
 * build a signable string precisely so this cannot be skipped.
 */

/**
 * Zs (ordinary spaces such as U+00A0) is deliberately NOT in this class: the
 * spec lists Cc, Cf, Cs, Co, Zl and Zp, and nothing else. Adding a category
 * here would produce bytes the server never stores.
 */
const SWEEPABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;

/**
 * The spec says "the ends are trimmed" without defining which characters count
 * as trimmable, which matters because Zs survives the substitution pass: if the
 * server trimmed only U+0020, a text with a leading U+00A0 would be stored with
 * that character intact and our signature would cover different bytes.
 *
 * PROBED 2026-09-04 against technocore.chat, in a scratch p- room: the server
 * strips U+0020, U+00A0, U+1680, U+2009, U+202F, U+205F and U+3000 from the
 * ends, and preserves every one of them in the interior. Every character in
 * JavaScript's own trim set that can survive the substitution pass is therefore
 * stripped by both, so `String.prototype.trim` matches the server and is used
 * directly. The rest of JavaScript's trim set (tab, newline, vertical tab, form
 * feed, U+2028, U+2029, U+FEFF) is Cc, Cf, Zl or Zp and has already become a
 * space before this runs.
 *
 * The probed characters are locked in by test/sweep.test.ts. If that suite ever
 * fails there, the server's trim has changed and this must stop calling `trim`
 * and enumerate the set explicitly.
 */
export function sweep(input: string): string {
  return input.replace(SWEEPABLE, ' ').trim();
}

/**
 * STATED [openapi 400]: a `text` or `value` "left empty by the single-line
 * sweep" is refused with a 400. Callers check this locally rather than spending
 * a write to discover it.
 */
export function isEmptyAfterSweep(input: string): boolean {
  return sweep(input).length === 0;
}
