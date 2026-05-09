# Clarifications — Stems Toggle

## Q1 — What activates the plugin?
**Resolved.** Activation is gated on a non-empty `song_info.stems[]` array in
the highway payload. PSARC songs reach `onSongReady`, see `stems.length === 0`,
run `teardown()`, and exit. The plugin is otherwise inert.

## Q2 — Why slave stems to the core element instead of using a single
`AudioBufferSourceNode` per stem?
**Resolved.** Two reasons: (1) `<audio>` elements stream — short attention to
memory for long sloppaks; (2) the core element is the timing source other
plugins (splitscreen, lyrics-sync, step-mode) rely on. Replacing it would
ripple through the whole ecosystem.

## Q3 — Why is there a sentinel `<span>` after each stem button?
**Resolved.** Several other plugins locate the close/last button with
`controls.querySelector('button:last-child')` and then call
`insertBefore(newBtn, closeBtn)`. Without a sentinel, the resolved node could
be a nested stem button — not a direct child of `#player-controls` — making
`insertBefore` throw `NotFoundError`. The sentinel keeps the stem button from
ever being `button:last-child` of its wrap. Comment in `screen.js`.

## Q4 — How is per-song memory namespaced?
**Resolved.** By `filename` (the same string passed to `playSong`). Two songs
with the same filename in different folders share state — accepted as a known
limitation of the existing Slopsmith library API.

## Q5 — What counts as "vocals" for karaoke mode?
**Open.** Today: any stem id matching `/vocal/i`. This catches `vocal`,
`vocals`, `Vocals`, `back-vocals`, etc. Acceptable for current sloppak
manifests but may overfit if future stems use richer naming
(e.g. `lead-vocals` vs `harmony-vocals`).

## Q6 — Why merge into an existing `window.stems` rather than overwrite?
**Resolved.** Plugin load order is not guaranteed. If a consumer (or a sibling
that exposes a compatible API) was loaded first, overwriting would break it.
The merge logic only fills slots that don't already exist; sealed/frozen
existing globals are tolerated with a warn-and-skip path.

## Q7 — What happens on songs with stems but where the core `<audio>` was
already pointed at `stems[0].url` by `highway.js`?
**Resolved.** `onSongReady` re-syncs: if the core was playing, every stem's
`currentTime` is set to `core.currentTime` and they all start. This is the
"already started before plugin init" path documented inline.

## Q8 — Should other plugins be able to subscribe to mute/volume changes?
**Open.** `stem_mixer` currently re-reads `getState()` on every UI tick; a
`subscribe(callback)` would be more efficient. Out of scope for v0.2.0.

## Q9 — Does the plugin work with custom (non-standard) stem ids?
**Resolved.** Yes — any id from the manifest is rendered as a button. The
**Mute on load** settings panel only iterates `COMMON_STEMS`, so non-standard
ids cannot be defaulted-muted from the UI today. See Q in spec.
