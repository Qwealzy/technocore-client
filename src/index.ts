/**
 * Public surface of technocore-client.
 *
 * Note what is absent: nothing here exposes private key material, and there is
 * no export that returns it. `Identity` is the only holder, and it hands out
 * the did:key and signatures only.
 */

export { sweep, isEmptyAfterSweep } from './sweep.js';

export {
  base58btcEncode,
  base58btcDecode,
  base64urlEncode,
  base64urlDecodeCanonical,
  isCanonicalSignature,
  SIGNATURE_PATTERN,
} from './encoding.js';

export {
  didKeyFromPublicKey,
  publicKeyFromDidKey,
  didNoteLocation,
  DID_KEY_PATTERN,
  ED25519_PUB_MULTICODEC,
  type DidNoteLocation,
} from './did.js';

export {
  messagePayload,
  notePayload,
  storedMessagePayload,
  storedNotePayload,
  NONCE_PATTERN,
  type Signable,
} from './payload.js';

export { Identity, type PassphraseProvider, type SignedText } from './identity.js';

export {
  verifyPayload,
  verifyStoredMessage,
  verifyStoredNote,
  type StoredMessage as VerifiableMessage,
  type StoredNote as VerifiableNote,
} from './verify.js';

export {
  roomName,
  nick,
  namespace,
  noteKey,
  roomClasses,
  NAME_PATTERN,
  ROOM_CLASS_PREFIXES,
  type RoomName,
  type Nick,
  type Namespace,
  type NoteKey,
  type RoomClass,
  type RoomClasses,
} from './names.js';

export {
  InvalidFieldError,
  TechnocoreError,
  BadFieldError,
  LaneRefusedError,
  NotFoundError,
  ConflictError,
  PayloadTooLargeError,
  DuplicateRefusedError,
  RateLimitedError,
  HeadersTooLargeError,
  UrlTooLongError,
  UnexpectedStatusError,
  errorForResponse,
  bodyNamesAField,
} from './errors.js';

export {
  RoomCursor,
  type GapCause,
  type ReadGap,
  type CursorStep,
  type CursorOptions,
  type PollOptions,
} from './rooms.js';

export {
  Transport,
  parseRoomPage,
  assertDid,
  assertSignature,
  DEFAULT_BASE_URL,
  SPEC_STATED_URL_BUDGET_BYTES,
  RFC7230_RECOMMENDED_REQUEST_LINE_BYTES,
  type TransportOptions,
  type FetchLike,
  type Lane,
  type LaneDecision,
  type UrlBudgetObservations,
  type StoredMessage,
  type RoomPage,
  type SignedWriteResult,
  type ReadPageOptions,
} from './transport.js';
