# Stems Toggle — Constitution

## Inheritance

Slopsmith's core plugin contract governs everything in this repo (manifest schema,
`window.playSong` / `highway` hooks, `screen.js` lifecycle, settings panel
mounting). This constitution lists only Stems Toggle's own non-negotiables.

## Core Principles

### I. Inert on PSARC
PSARC songs (`song_info.stems` empty / missing) MUST run untouched. The plugin
constructs no Web Audio graph, injects no UI, and overrides nothing for those
songs. The presence of this plugin must never make a PSARC sound or feel different.

### II. Core `<audio>` is the timing master
For sloppak songs, `<audio id="audio">` is muted (`volume = 0`) and treated as a
silent timing master. Per-stem `<audio>` elements slave to the master via
`onplay`, `onpause`, `onseeking`, `onratechange`. Drift > 50 ms on `play` is
corrected by snapping `currentTime`. The master MUST NOT be replaced —
splitscreen, step-mode, lyrics-sync, and other plugins all read from it.

### III. Mute via gain, not pause
Toggling a stem MUST be a `GainNode.gain.value` change. No `pause()`/`play()`
on the per-stem element — that causes audible glitches and re-buffer storms.
Volume sliders also drive gain only.

### IV. Per-song memory is local
Mute and volume state is keyed by `filename` in `localStorage` under
`stemsMute:` and `stemsVol:` prefixes. Default-muted preset and karaoke flag
live under `stemsDefaultMuted` and `stemsKaraokeDefault`. No server persistence.

### V. Public API stability
`window.stems` is a published surface consumed by other plugins (notably
`stem_mixer`). The minimum contract:
- `getState()` → array of live references `{id, vol, on, gain, audio}`
- `setVolume(id, v)` (clamped to `[0, 1]`, NaN ignored)
- `setMuted(id, m)` (boolean coerced via `coerceBool`)
- `stemState` accessor (live array)
Renames or shape changes are breaking and require synchronised consumer updates.

### VI. Tear-down on screen change
Leaving the `player` screen MUST run the teardown path: stop stem audios,
disconnect Web Audio nodes, restore the core `<audio>` to `volume = 1`, and
remove the injected `#stems-mixer` container. The shared `AudioContext` MAY be
kept alive to avoid the "too many audio contexts" browser warning.

## Governance

Amendments must update this file together with `specs/001-stems-toggle/plan.md`
and the README "How it works" section. The `window.stems` API contract may only
change with a synchronised update of every consumer (grep the Slopsmith
ecosystem for `window.stems.`).

**Version**: 1.0.0 | **Ratified**: 2026-05-09 | **Last Amended**: 2026-05-09
