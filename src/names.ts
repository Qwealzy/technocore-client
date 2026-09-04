import { InvalidFieldError } from './errors.js';

/**
 * Names, and the room classes that compose out of their prefixes.
 *
 * STATED: "Names (<room>, <nick>, <ns>, <key>) match
 * /^[a-z0-9][a-z0-9_-]{0,47}$/."
 *
 * Names are SEMANTIC parameters. STATED [PARAMETERS]: semantic values "are
 * REFUSED with a 400 whose first line names the field" and "Nothing is
 * type-coerced". So they are validated here, before a request is spent, and the
 * branded types below mean an unvalidated string cannot reach a call site by
 * accident.
 */

export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

export type RoomName = string & { readonly __brand: 'RoomName' };
export type Nick = string & { readonly __brand: 'Nick' };
export type Namespace = string & { readonly __brand: 'Namespace' };
export type NoteKey = string & { readonly __brand: 'NoteKey' };

function assertName(value: string, field: string): void {
  if (typeof value !== 'string') {
    // STATED [PARAMETERS]: {"from": 0} is a 400, "not the nickname 0". We do
    // not stringify either.
    throw new InvalidFieldError(field, 'must be a string');
  }
  if (!NAME_PATTERN.test(value)) {
    throw new InvalidFieldError(field, 'must match ^[a-z0-9][a-z0-9_-]{0,47}$');
  }
}

export function roomName(value: string): RoomName {
  assertName(value, 'room');
  return value as RoomName;
}

export function nick(value: string): Nick {
  assertName(value, 'from');
  return value as Nick;
}

export function namespace(value: string): Namespace {
  assertName(value, 'ns');
  return value as Namespace;
}

export function noteKey(value: string): NoteKey {
  assertName(value, 'key');
  return value as NoteKey;
}

/**
 * STATED [ROOM CLASSES]: "a name is <class>-...-<body> and classes compose by
 * prefix", with p- unlisted, mb- mailbox, d- ownable and e- ephemeral.
 */
export const ROOM_CLASS_PREFIXES = ['p-', 'mb-', 'd-', 'e-'] as const;

export type RoomClass = 'p' | 'mb' | 'd' | 'e';

export interface RoomClasses {
  /** In the order they appear, outermost first: `mb-p-x` gives ['mb', 'p']. */
  readonly classes: readonly RoomClass[];
  /** What is left once every leading class prefix is stripped. */
  readonly body: string;
  /** STATED: unlisted — reachable, never enumerated. */
  readonly unlisted: boolean;
  /** STATED: mailbox — signed writes only, unsigned ones get 403. */
  readonly mailbox: boolean;
  /** STATED: ownable — a did:key claim can gate writes. */
  readonly ownable: boolean;
  /** STATED: ephemeral — messages older than the deployment's TTL stop being returned. */
  readonly ephemeral: boolean;
}

/**
 * Parses a room name's leading class prefixes.
 *
 * Classes compose by prefix, so this strips repeatedly rather than checking a
 * fixed set of known names. STATED, and the reason this is a loop: "The cost of
 * prefixes: a room about e-commerce named `e-commerce` IS ephemeral. Name it
 * `ecommerce` if you did not mean that."
 *
 * `mb-` is tested before `d-` and `e-` only because the list is ordered; the
 * prefixes are mutually unambiguous, since no prefix is a prefix of another.
 */
export function roomClasses(name: string): RoomClasses {
  const classes: RoomClass[] = [];
  let rest = name;
  let matched = true;
  while (matched) {
    matched = false;
    for (const prefix of ROOM_CLASS_PREFIXES) {
      if (rest.startsWith(prefix)) {
        classes.push(prefix.slice(0, -1) as RoomClass);
        rest = rest.slice(prefix.length);
        matched = true;
        break;
      }
    }
  }
  return {
    classes,
    body: rest,
    unlisted: classes.includes('p'),
    mailbox: classes.includes('mb'),
    ownable: classes.includes('d'),
    ephemeral: classes.includes('e'),
  };
}
