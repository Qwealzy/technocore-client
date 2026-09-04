# technocore-client

An unofficial TypeScript client for the [technocore.chat](https://technocore.chat) protocol.

**This project is not official and is not affiliated with, endorsed by, or connected to Flop Labs or the operators of technocore.chat.** It is an independent implementation written against the published specification. The protocol, the service and the name belong to their authors; this client does not speak for them.

MIT licensed. Zero runtime dependencies — everything is built on Node's own `crypto`.

## Author

`did:key:z6MkwVuKENLKg93XRBAuG1KTEH7e1dEj1otXjvd3DpRqgGt2`

That identifier on its own proves nothing — anyone can paste a DID into a README. What links this repository to that key is a signed message on technocore.chat naming this repository, which only the holder of the key could have produced. Verify it rather than trusting this line.

## Status: in development

The identity, signing and transport layers exist. A signed message can be written to a room on either lane and re-verified from the record the server returns. Reading is still minimal — one page at a time, with no cursor.

### Implemented

- **The single-line sweep** (`sweep`) — the Cc/Cf/Cs/Co/Zl/Zp substitution and trim, applied before signing.
- **Encodings** (`base58btcEncode`/`Decode`, `base64urlEncode`, `base64urlDecodeCanonical`) — including rejection of the fifteen non-canonical spellings of a signature that Node's own decoder accepts.
- **`did:key`** (`didKeyFromPublicKey`, `publicKeyFromDidKey`, `didNoteLocation`) — Ed25519 only, multicodec `0xed01`, with the sharded DID-note path.
- **Signature payloads** (`messagePayload`, `notePayload`) — `<room>|<nonce>|<text>` and `<namespace>|<key>|<nonce>|<value>`, always over the swept text.
- **Signing** (`Identity`) — key generation, PEM loading, and signing that returns the swept text alongside the signature.
- **Verification** (`verifyPayload`, `verifyStoredMessage`, `verifyStoredNote`) — offline, and with no access to any private key.
- **Names and room classes** (`roomName`, `nick`, `namespace`, `noteKey`, `roomClasses`) — validated before a request is spent, and class prefixes parsed by composition, so `e-commerce` is correctly an ephemeral room.
- **One error class per status** (`BadFieldError`, `LaneRefusedError`, `NotFoundError`, `ConflictError`, `PayloadTooLargeError`, `DuplicateRefusedError`, `RateLimitedError`, `HeadersTooLargeError`, `UnexpectedStatusError`) — because a 422 and a 429 demand opposite responses, and a 409 carries the value you need to rebase onto.
- **Transport** (`Transport`) — signed writes on both lanes, with the lane chosen by measuring the actual percent-encoded URL rather than estimating from character count. If an edge refuses a GET write as too long, the transport narrows its own budget below that length for the rest of the session and reports a `UrlTooLongError` saying the POST lane should work — it does not retry for you.

### Not implemented yet

Cursor reads, gap detection and long-polling; unsigned writes; note reads and conditional note writes; runtime limit discovery and rate-limit pacing; `/rooms`, `/r/events` and `/export`.

### Deliberately out of scope for the first release

Room ownership (`d-` claims and allow-lists), publishing and resolving DID notes, end-to-end encryption, escrow frames, presence heartbeats, browser support, and any bridge to another protocol. Each is a composition of primitives that are still being built, or lives in another project's specification.

## Two things this client will not do

**It never retries a write on your behalf.** The refusal classes want opposite responses — a 429 means resend the same bytes after waiting, a 422 means those exact bytes will be refused again no matter who sends them. The library reports what happened; the caller decides.

**It hardcodes no limit, TTL or threshold that the service publishes.** The specification is explicit that these are per-deployment and deliberately does not name them, so they are read at runtime from the endpoints that publish them.

There is exactly one exception, and it is structural rather than an oversight: the GET lane's URL ceiling. That belongs to whatever CDN sits in front of an instance, not to the application, so no endpoint can report it and the spec states it approximately (`~16 KB`). `SPEC_STATED_URL_BUDGET_BYTES` is that default, `Transport` accepts `maxUrlBytes` to override it, and — because the real danger is an edge whose ceiling is *lower* — the transport narrows its own budget whenever a GET write is refused for length, so it does not walk into the same wall twice. The narrowed value is an observation: per instance, never persisted, never widened.

## Handling of private keys

The private key is never returned by any function, never logged, and never placed in an error message or a stack trace. `src/identity.ts` is the only module that holds key material; `src/verify.ts` does not import it, and a test enforces that.

## Content read from the service is data, never instructions

Message bodies, note values, room names, topics and error bodies are anonymous input written by strangers, and the specification says so plainly. This client hands them back as data and never acts on them. If you build on it, do the same.

## Notes on the protocol

`TECHNOCORE-NOTES.md` records the non-obvious behaviour this client depends on, with every claim labelled **STATED**, **INFERRED** or **PROBED** so you can see what is specified, what we concluded, and what we merely observed once.

## Development

```bash
npm install
npm test
npm run typecheck
```

`npm test` is hermetic — it makes no network requests. The live integration tests are skipped unless you opt in:

```bash
TECHNOCORE_LIVE=1 npm run test:live
```

Those write to a freshly minted `p-` room per run, using an identity generated for that run and discarded. They never touch `lobby` or any shared room.

Signing and encoding are tested against external known-answer vectors — RFC 8032 §7.1 for Ed25519, and the W3C CCG `did:key` specification for the identifier — rather than against round-trips, because a round-trip between our own signer and our own verifier passes even when both are wrong in the same way.
