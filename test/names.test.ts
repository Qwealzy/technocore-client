import { describe, expect, it } from 'vitest';
import { roomName, nick, namespace, noteKey, roomClasses, NAME_PATTERN } from '../src/names.js';
import { InvalidFieldError } from '../src/errors.js';

describe('name validation', () => {
  it('accepts what the stated pattern accepts', () => {
    for (const value of ['a', 'lobby', 'p-abc', 'a_b-c', '9', 'a'.repeat(48)]) {
      expect(NAME_PATTERN.test(value)).toBe(true);
      expect(roomName(value)).toBe(value);
    }
  });

  it('refuses what it refuses, naming the field', () => {
    const bad = ['', '-abc', '_abc', 'Abc', 'a b', 'a.b', 'a/b', 'a'.repeat(49), 'did:key:z6Mk'];
    for (const value of bad) {
      expect(() => roomName(value)).toThrow(InvalidFieldError);
      try {
        roomName(value);
      } catch (error) {
        expect((error as InvalidFieldError).field).toBe('room');
      }
    }
  });

  it('names each field by the name the server uses', () => {
    const fields: readonly (readonly [(v: string) => string, string])[] = [
      [roomName, 'room'],
      [nick, 'from'],
      [namespace, 'ns'],
      [noteKey, 'key'],
    ];
    for (const [make, field] of fields) {
      try {
        make('NOT VALID');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as InvalidFieldError).field).toBe(field);
      }
    }
  });

  it('does not coerce a non-string', () => {
    // STATED [PARAMETERS]: {"from": 0} is a 400, "not the nickname 0".
    expect(() => roomName(0 as unknown as string)).toThrow(/must be a string/);
    expect(() => nick(null as unknown as string)).toThrow(/must be a string/);
  });
});

describe('room classes compose by prefix', () => {
  it('reads a single class', () => {
    expect(roomClasses('p-abc')).toMatchObject({ classes: ['p'], body: 'abc', unlisted: true });
    expect(roomClasses('mb-abc')).toMatchObject({ classes: ['mb'], body: 'abc', mailbox: true });
    expect(roomClasses('d-jobs')).toMatchObject({ classes: ['d'], body: 'jobs', ownable: true });
    expect(roomClasses('e-abc')).toMatchObject({ classes: ['e'], body: 'abc', ephemeral: true });
  });

  it('composes stacked classes', () => {
    // STATED: "mb-p-<random> is a private mailbox; e-p-<random> a private room
    // that decays."
    const mailbox = roomClasses('mb-p-9f2c81d0');
    expect(mailbox.classes).toEqual(['mb', 'p']);
    expect(mailbox.mailbox).toBe(true);
    expect(mailbox.unlisted).toBe(true);
    expect(mailbox.body).toBe('9f2c81d0');

    const decaying = roomClasses('e-p-9f2c81d0');
    expect(decaying.classes).toEqual(['e', 'p']);
    expect(decaying.ephemeral).toBe(true);
    expect(decaying.unlisted).toBe(true);
  });

  it('treats e-commerce as ephemeral, because it is', () => {
    // STATED [ROOM CLASSES]: "The cost of prefixes: a room about e-commerce
    // named `e-commerce` IS ephemeral. Name it `ecommerce` if you did not mean
    // that."
    const accidental = roomClasses('e-commerce');
    expect(accidental.ephemeral).toBe(true);
    expect(accidental.body).toBe('commerce');

    const intended = roomClasses('ecommerce');
    expect(intended.ephemeral).toBe(false);
    expect(intended.classes).toEqual([]);
    expect(intended.body).toBe('ecommerce');
  });

  it('reads a plain room as having no class', () => {
    for (const plain of ['lobby', 'meta', 'tclk-offers', 'events']) {
      expect(roomClasses(plain).classes).toEqual([]);
      expect(roomClasses(plain).body).toBe(plain);
    }
  });

  it('keeps stripping while a class prefix remains', () => {
    // Composition is by prefix and is not limited to the documented pairs.
    expect(roomClasses('p-p-x').classes).toEqual(['p', 'p']);
    expect(roomClasses('mb-e-p-x').classes).toEqual(['mb', 'e', 'p']);
  });

  it('does not mistake a longer prefix for a shorter one', () => {
    // 'mb-' must not be read as 'm' + something, and 'd-' must not swallow
    // 'd-jobs' into a further class.
    expect(roomClasses('mb-x').classes).toEqual(['mb']);
    expect(roomClasses('d-e-x').classes).toEqual(['d', 'e']);
  });
});
