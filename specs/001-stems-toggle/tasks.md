# Tasks — Stems Toggle

Status legend: `DONE` (shipped in v0.2.0), `OPEN` (not yet implemented), `[P]` (parallelisable).

## US-1 — Toggle stem mid-song
- [DONE] Inject one button per stem into `#player-controls`.
- [DONE] Click toggles `s.on` and writes `gain.gain.value`.
- [DONE] Persist mute set under `stemsMute:<filename>`.

## US-2 — Per-stem volume slider
- [DONE] Shift+click opens popover with `<input type=range>` 0–100.
- [DONE] Persist volume under `stemsVol:<filename>[id]`.
- [DONE] Outside-click dismisses popover.

## US-3 — Karaoke mode default
- [DONE] Settings checkbox writes `stemsKaraokeDefault`.
- [DONE] On new song without saved mute set, vocals stems start muted.

## US-4 — Mute-on-load preset
- [DONE] Settings panel renders a checkbox per `COMMON_STEMS`.
- [DONE] Checked stems start muted on songs without saved state.
- [OPEN] [P] Render checkboxes for non-standard stem ids observed at runtime.

## US-5 — Per-song memory
- [DONE] Saved mute state takes precedence over karaoke and default-muted.
- [DONE] Saved volumes restored on next load.

## US-6 — Inert on PSARC
- [DONE] `stems.length === 0` guard in `onSongReady`.
- [DONE] Teardown is idempotent and safe to call without prior buildGraph.

## US-7 — Sync stems to core
- [DONE] `onplay`, `onpause`, `onseeking`, `onratechange` handlers installed.
- [DONE] 50 ms drift threshold on `play`.

## US-8 — Public API
- [DONE] `getState`, `setVolume`, `setMuted`, `stemState` accessor.
- [DONE] Merge semantics: don't clobber pre-existing `window.stems`.
- [OPEN] [P] Add `subscribe(cb)` for change notifications (Q8).

## Cross-cutting
- [DONE] Sentinel `<span>` after each stem button (Q3).
- [DONE] Idempotency guard for `installHooks` (`wired` flag).
- [DONE] Restoration of core `<audio>` volume on teardown.
- [OPEN] Automated test harness — none today; manual smoke testing only.
- [OPEN] [P] Surface per-song volumes in the settings panel for review/reset.
