# Spec — Stems Toggle (`stems`)

> Retrospective spec for shipped v0.2.0. The implementation in `screen.js` and
> `settings.html` is the source of truth.

## Summary

A Slopsmith plugin that turns multi-stem `.sloppak` songs into a live mixing
board. For sloppaks, it mutes the core `<audio>` element and creates one new
`<audio>` per stem routed through a `GainNode` chain. Mute toggles and volume
sliders are injected into `#player-controls`. Per-song mute / volume state is
remembered in `localStorage`. PSARC songs are untouched. Other plugins consume
the `window.stems` API.

## User stories

### US-1 — Toggle a stem mid-song
**Given** a sloppak with multiple stems is playing,
**When** I click a stem button in the player controls bar,
**Then** that stem mutes (gain → 0) or unmutes (gain → saved volume), without
audio glitching, and the change is persisted under
`localStorage["stemsMute:<filename>"]`.

### US-2 — Adjust per-stem volume
**Given** a stem button is visible,
**When** I shift+click it,
**Then** a popover slider appears anchored to the button. Dragging changes the
gain in real time and persists to `localStorage["stemsVol:<filename>"][id]`.
**And When** I click outside the popover, it closes.

### US-3 — Karaoke mode default
**Given** I enable **Karaoke mode** in Settings → Stems Toggle,
**When** any new song opens (no per-song saved state yet),
**Then** any stem whose id matches `/vocal/i` starts muted automatically.
A per-song mute toggle still overrides on subsequent loads.

### US-4 — Mute-on-load preset
**Given** I tick `bass` and `vocals` in **Settings → Stems Toggle → Mute on
load**,
**When** any new song opens,
**Then** those stems start muted. Saved per-song state continues to win when
present.

### US-5 — Per-song memory
**Given** I muted vocals on a song last week,
**When** I open the same song again,
**Then** vocals are muted on load and the previously set volumes are restored.

### US-6 — Inert on PSARC
**Given** the song's `song_info.stems` is empty or missing,
**When** the song loads,
**Then** the stems UI MUST NOT appear, no per-stem `<audio>` elements are
created, and the core `<audio>` is left at default volume.

### US-7 — Sync stems to core
- On `core.onplay`: every stem `<audio>` is played; if drift > 50 ms,
  `currentTime` is snapped to `core.currentTime`.
- On `core.onpause`: every stem is paused.
- On `core.onseeking`: every stem's `currentTime` is set to `core.currentTime`.
- On `core.onratechange`: every stem's `playbackRate` is updated.

### US-8 — Public API
Other plugins call `window.stems.getState()`, `setVolume()`, `setMuted()`. The
returned objects MUST be live references suitable for direct mutation of
`gain.gain.value` (this is exercised by `stem_mixer`).

## Functional requirements

| ID    | Requirement                                                                                  | Source                          |
|-------|----------------------------------------------------------------------------------------------|---------------------------------|
| FR-1  | On sloppak load, mute core `<audio>` (`volume = 0`) and create per-stem `<audio>` + `GainNode`. | `screen.js` `buildGraph`        |
| FR-2  | Inject one labelled button per stem into `#player-controls`, before the `span.text-gray-700` separator. | `screen.js` `injectUI`          |
| FR-3  | Click toggles on/off; shift+click opens a volume popover.                                    | `screen.js` button `onclick`    |
| FR-4  | Persist mute set under `stemsMute:<filename>`; volumes under `stemsVol:<filename>`.          | `screen.js` save/load helpers   |
| FR-5  | Karaoke flag at `localStorage["stemsKaraokeDefault"] = "1"|"0"`.                              | `screen.js` `KARAOKE_KEY`       |
| FR-6  | Mute-on-load preset under `stemsDefaultMuted` (JSON array of stem ids).                       | `screen.js` `DEFAULT_MUTED_KEY` |
| FR-7  | Drift correction threshold = 0.05 s on `play`.                                                | `screen.js` `DRIFT_THRESHOLD`   |
| FR-8  | Teardown on screen change: stop stems, disconnect nodes, remove UI, restore core volume to 1. | `screen.js` `teardown`          |
| FR-9  | Expose `window.stems` with `getState`, `setVolume`, `setMuted`, `stemState`. Merge with any pre-existing `window.stems` rather than overwrite. | `screen.js` API merge block     |
| FR-10 | Insert sentinel `<span style="display:none">` after each stem button so other plugins' `button:last-child` lookups don't resolve to a stem. | `screen.js` sentinel comment    |
| FR-11 | Coerce non-boolean inputs to `setMuted` via `coerceBool` (`'false'`, `'0'`, `''`, `null`, `0` → `false`). | `screen.js` `coerceBool`        |
| FR-12 | `setVolume` clamps to `[0, 1]` and ignores `NaN`/non-finite.                                  | `screen.js` `setVolume`         |

## Non-functional

- Toggle latency: a single `gain.gain.value = …` write — sub-frame.
- No network egress.
- Compatibility: requires the core's sloppak format support (`feature/sloppak-format` and descendants).
- Browser: any with `AudioContext`/`webkitAudioContext` and `MediaElementAudioSourceNode`.

## Out of scope

- Server-side stem extraction (handled by `slopsmith-plugin-sloppak-converter`).
- EQ, compression, profiles, or autolevel (consumed by `slopsmith-plugin-stem-mixer`).
- Cross-device state sync.

## Open clarifications

- [NEEDS CLARIFICATION] Should mute-on-load match by stem id substring (today)
  or by exact id only? Currently `vocals` matches the `karaoke` regex `/vocal/i`,
  which would also match a hypothetical `back-vocals` stem.
- [NEEDS CLARIFICATION] Should the public API include a `subscribe(callback)`
  for state-change events, so consumers don't poll `getState()`?
- [NEEDS CLARIFICATION] When the manifest declares a stem with an unknown id
  (not in `COMMON_STEMS`), it appears in the player UI but not in
  **Settings → Mute on load**. Acceptable, or should the settings UI grow to
  include observed stems dynamically?
