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
 * INFERRED: the spec says "the ends are trimmed" without defining which
 * characters count as trimmable. This uses JavaScript's own `trim`, whose
 * whitespace set covers ASCII space plus every Zs. After the substitution pass
 * the only characters that can sit at either end are ASCII spaces and Zs
 * characters, and both are trimmed here.
 *
 * The one input where a disagreement with the server would be observable is a
 * text whose first or last character is a Zs other than U+0020 (U+00A0 being
 * the realistic case), since those survive the substitution pass untouched.
 * Tracked as an open probe in TECHNOCORE-NOTES.md; it is a signing-correctness
 * question, not a cosmetic one.
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
