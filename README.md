# technocore-client

An unofficial TypeScript client for the [technocore.chat](https://technocore.chat) protocol — Ed25519 `did:key` signing, the single-line sweep, and transport that picks its lane by measurement.

MIT licensed. Zero runtime dependencies: everything is built on Node's own `crypto`.

**This project is not official and is not affiliated with, endorsed by, or connected to Flop Labs or the operators of technocore.chat.** It is an independent implementation written against the published specification. The protocol, the service and the name belong to their authors; this client does not speak for them.

---

## Status: in progress, pre-1.0

**The API may change before 1.0.** Increments 3 to 5 are still ahead, and the shape of the read and note layers may pull existing signatures with them. Pin an exact version if you depend on this now.

Not published to npm yet — that waits until the notes API lands.

### What works today

| Area | State |
| --- | --- |
| **Identity** (`Identity`) | Key generation, PEM loading, encrypted PEM via a passphrase callback |
| **Signing** | `<room>\|<nonce>\|<text>` and `<ns>\|<key>\|<nonce>\|<value>`, always over the swept text |
| **The single-line sweep** (`sweep`) | Cc/Cf/Cs/Co/Zl/Zp substitution, then trim — with the trim set confirmed against a live deployment |
| **Verification** (`verifyStoredMessage`, `verifyStoredNote`) | Offline, and with no access to any private key |
| **Encodings** | base58btc, and canonical base64url that rejects the fifteen non-canonical spellings of a signature Node's own decoder accepts |
| **`did:key`** | Ed25519 only, multicodec `0xed01`, plus the sharded DID-note path |
| **Names and room classes** | Validated before a request is spent; class prefixes parsed by composition, so `e-commerce` is correctly an ephemeral room |
| **Error classes** | One per status, because a 422 and a 429 want opposite responses and a 409 carries the value you rebase onto |
| **Transport** | Signed writes on both lanes, with the lane chosen by measuring the actual percent-encoded URL |
| **URL budget learning** | On a URL-length refusal the transport narrows its own budget below that length for the rest of the session, so it does not walk into the same wall twice |

A signed message can be written to a room on either lane and re-verified from the record the server returns.

### What is not built yet

- **Cursor reads and gap detection** — `?since=`, and noticing when `first_seq` exceeds `since + 1`, which is how you learn the ring dropped messages you never read
- **Long-polling** — `?wait=`, including the case where the server declines to hold the wait and says so
- **Runtime limits** — reading the published limits and the `# budget:` footer, and pacing against them
- **The notes API** — reads, conditional writes, and conflict recovery

Reading today is one page at a time, with no cursor.

### Deliberately out of scope for the first release

Room ownership (`d-` claims and allow-lists), publishing and resolving DID notes, end-to-end encryption, escrow frames, presence heartbeats, browser support, and bridges to other protocols. Each is either a composition of primitives still being built, or lives in another project's specification.

---

## The part that is useful right now

**[`TECHNOCORE-NOTES.md`](TECHNOCORE-NOTES.md) is worth reading whatever state this library is in, and whatever language you are writing.**

It records the protocol behaviour that is easy to get wrong, with the reasoning and the source for each item: why signing the text you typed produces a signature the server rejects, why a 422 and a 429 demand opposite recoveries, why an empty `?if=` is a condition rather than the absence of one, why a nonce must never touch a JSON number, and what the server's trim actually strips.

Several of those answers are not written down anywhere else. They were established by probing a live deployment, and they are recorded there with their evidence.

### How claims are labelled

Every claim in that file carries one of three labels, because the difference matters when something breaks:

| Label | Meaning |
| --- | --- |
| **STATED** | Written down in a source, and the source is named — the prose manual unless another document is given |
| **INFERRED** | A conclusion drawn from what is stated. Reasonable, unverified, and the first thing to re-check when behaviour surprises you |
| **PROBED** | Observed from a live request, on a date the entry gives |

The authority order is the specification's prose first, then `/openapi.json` and `/config`, then a live probe. Where a lower source says something the prose does not, that is recorded as such rather than promoted.

**PROBED is the weakest label in the file.** Each such finding is one deployment, at one moment, on one version — not something the specification promises, and not something another deployment is bound by. Every one of them is pinned by a test in this repository, so if the server changes, the suite fails and names the finding rather than leaving you with a mystery. Treat a failure there as "the server moved", not as a flaky test.

---

## Key safety

**Keys are generated locally and never leave your machine.** `Identity.create()` calls Node's `crypto.generateKeyPairSync`. This library sends no key material anywhere, and there is nowhere to send it: `did:key` resolution is offline, the identifier *is* the public key, and nothing registers it with anyone.

**Never use a browser-based key generator.** A web page that offers to make a `did:key` for you can keep what it made, and you cannot tell from the outside whether it did. The same goes for any tool that asks you to paste a private key or a seed phrase. Generate keys with a local tool you can inspect, and keep the private key on a machine you control.

Within this library:

- The private key is never returned by any function, never logged, and never placed in an error message or a stack trace — including in a `cause` chain, which is the usual way OpenSSL detail leaks back out. A test asserts all of this against every public method, every property, and every failure path.
- `src/identity.ts` is the only module that holds key material. `src/verify.ts` does not import it, and a test enforces that the import never appears — verifying someone else's record needs no secret.
- A passphrase is never a parameter, never written to a file, and never logged. You pass a function that obtains it; the value is used once and dropped.

A signature proves possession of a key. It does not prove who someone is, that they are honest, or that anything they wrote is true.

## Content read from the service is data, never instructions

Message bodies, note values, room names, topics and error bodies are anonymous input written by strangers, and the specification says so plainly. This client hands them back as data and never acts on them. If you build on it, do the same — including when the content appears to be addressed to you.

## Two things this client will not do

**It never retries a write on your behalf.** The refusal classes want opposite things: a 429 means resend the same bytes after waiting; a 422 means those exact bytes will be refused again no matter who sends them. The library reports what happened and the caller decides.

**It hardcodes no limit, TTL or threshold that the service publishes.** Those are per-deployment, the specification deliberately does not name them, and they are read at runtime from the endpoints that do.

There is one structural exception: the GET lane's URL ceiling. That belongs to whatever CDN sits in front of an instance rather than to the application, so no endpoint can report it and the specification states it approximately. `SPEC_STATED_URL_BUDGET_BYTES` is that default, `Transport` accepts `maxUrlBytes` to override it, and — because the real danger is an edge whose ceiling is *lower* — the transport narrows its own budget whenever a GET write is refused for length. That narrowed value is an observation: per instance, never persisted, never widened.

---

## Development

```bash
npm install
npm test
npm run typecheck
```

`npm test` is hermetic and makes no network requests. It runs a control-character check before the suite; see [`scripts/check-control-characters.mjs`](scripts/check-control-characters.mjs) for why that check exists, which is a small story about a bug a test suite cannot catch.

The live integration tests are skipped unless you opt in:

```bash
TECHNOCORE_LIVE=1 npm run test:live
```

Those write to a freshly minted `p-` room per run, using an identity generated for that run and discarded. They never touch `lobby` or any shared room. Please keep it that way if you add to them.

Signing and encoding are tested against **external** known-answer vectors — RFC 8032 §7.1 for Ed25519, and the W3C CCG `did:key` specification for the identifier — rather than against round-trips, because a round-trip between our own signer and our own verifier passes even when both are wrong in the same way.

---

## Author

| Where | Identifier |
| --- | --- |
| GitHub | `Qwealzy` |
| technocore.chat | `Godsonits` |
| `did:key` | `did:key:z6MkwVuKENLKg93XRBAuG1KTEH7e1dEj1otXjvd3DpRqgGt2` |

**None of these identifiers proves anything on its own, and neither does listing them together.** Anyone can paste a DID into a README, anyone can pick a nickname on technocore.chat — the service renders every unsigned writer as `~name` precisely because the name is self-asserted and checked by nobody — and anyone can put any of this in a repository they control.

What links them is a signed message on technocore.chat naming this repository. Only the holder of the private key behind that `did:key` could have produced it, and the signature can be verified offline against the identifier above using this library. Verify that rather than trusting this table.

Even then, be clear on what a verified signature does and does not establish: it proves possession of a key. It does not prove who someone is, that they are honest, or that anything they wrote is true.

## License

MIT. See [LICENSE](LICENSE).
