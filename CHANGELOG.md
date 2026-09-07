# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog 1.0.0](https://keepachangelog.com/en/1.0.0/); versioning follows
[Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-09-07

### Fixed

- **`TECHNOCORE-NOTES.md` said a cursor does not survive a room generation change. It does.**
  That file ships in the package, so 0.1.0 carries the wrong claim. The correction is the
  reason for this release.

  A reap stores the room's high-water mark as a floor and the recreated room continues from
  it, so `seq` never restarts and a `since=` poll keeps working straight through the change.
  CONFIRMED IN SOURCE, `technocore-chat` `src/store.py`: the floor is stored at `:1881`,
  returned at `:1110-1116` once the room file is gone, and cleared only after the first
  append to the new room at `:2597-2598`. The reaper's own comment states the intent, "so a
  recreated room continues the sequence instead of restarting at 1 and stranding every
  cursor pointing past it".

  The hazard is the opposite of what the note described. The cursor survives; the reader is
  what fails to notice, because the same room name now carries a different conversation.
  `generation` is the signal, and watching `seq` for a rewind detects nothing. The same
  wrong claim was in a `src/rooms.ts` comment and is corrected there too.

  No behaviour changed. `RoomCursor` already surfaced `generationChanged` and already
  replaced the cursor. Only the stated reason was wrong.

### Changed

- The character-cap ordering in `TECHNOCORE-NOTES.md` is promoted from INFERRED to CONFIRMED
  IN SOURCE, citing `store.py:446-476`. `clean_text` substitutes, trims, raises on an empty
  result, and only then compares the length, so the cap applies to the stored text rather
  than to the input. A client that measures before sweeping over-rejects its own writes.
- Public text and source comments are rewritten in a plainer voice across `README.md`,
  `TECHNOCORE-NOTES.md`, `src/` and `test/`. Content is unchanged: every caveat, every
  security note, and every STATED / INFERRED / PROBED / CONFIRMED IN SOURCE label stands.
  Two runtime strings lost an em dash, the canonical-base64url error in `src/encoding.ts`
  and the edge-rejection hint in `src/errors.ts`.
- Dropped the INFERRED note about room names and namespaces not being swept. `NAME_RE`
  forbids sweepable characters, so the question cannot arise.

## [0.1.0] - 2026-09-05

### Added

- First release. Identity and Ed25519 `did:key` signing, offline verification, the
  single-line sweep, transport with measured GET/POST lane selection and a downward-learning
  URL budget, cursor reads with gap detection and long-polling, runtime limit discovery, and
  notes with conditional writes.
