# Plan — Stems Toggle (as built)

## File map

| File              | Lines | Purpose                                                                |
|-------------------|-------|------------------------------------------------------------------------|
| `plugin.json`     | 8     | Manifest. `id: stems`, version `0.2.0`, no nav, declares `screen.js` and `settings.html`. |
| `screen.js`       | 453   | All client logic: state I/O, Web Audio graph, UI injection, sync hooks, public API. IIFE. |
| `settings.html`   | 26    | Karaoke checkbox + dynamic Mute-on-load checklist (rendered by `screen.js` on settings mount). |
| `README.md`       | 62    | User-facing how-it-works.                                              |
| `CLAUDE.md`       | 4     | SPECKIT preamble.                                                      |

## Architecture

```
                     core <audio id="audio">  (volume = 0, timing master)
                                │
                onplay/pause/seeking/ratechange
                                ▼
            ┌───────────────────────────────────────────┐
            │ for each stem in song_info.stems[]:       │
            │                                           │
            │   <audio src=stem.url>                    │
            │           │                               │
            │   MediaElementAudioSourceNode             │
            │           │                               │
            │   GainNode (gain = on ? vol : 0) ─────────┼──► AudioContext.destination
            │                                           │
            │   button in #player-controls              │
            │     • click: toggle (gain.gain.value)     │
            │     • shift+click: volume popover         │
            └───────────────────────────────────────────┘
```

## State machine (per song)

```
   load song ──► teardown() ──► info = highway.getSongInfo()
                                       │
                              stems empty? ──yes──► (PSARC) exit
                                       │
                                       no
                                       ▼
                                 buildGraph()
                                       │
                                hookCoreAudio()
                                       │
                                   injectUI()
                                       │
                  ┌────────────────────┴────────────────────┐
                  │                                         │
        showScreen(!= 'player')                       new playSong()
                  │                                         │
                  └─────────────► teardown() ◄──────────────┘
```

## Storage keys

| Key                         | Type              | Set when                         |
|-----------------------------|-------------------|----------------------------------|
| `stemsKaraokeDefault`       | `"0"` or `"1"`    | settings checkbox change         |
| `stemsDefaultMuted`         | JSON `string[]`   | settings "Mute on load" change   |
| `stemsMute:<filename>`      | JSON `string[]`   | per-song mute toggle             |
| `stemsVol:<filename>`       | JSON `{id:vol}`   | per-song volume change           |

## Public API (`window.stems`)

```js
window.stems = {
  getState()           // → [{id, vol, on, gain, audio}, …] live refs
  setVolume(id, vol)   // [0,1] clamp; NaN ignored; case-insensitive id
  setMuted(id, muted)  // coerceBool() for truthiness
  get stemState()      // live array of internal state objects
};
```

Merge semantics: existing slots on `window.stems` are not clobbered. See Q6
in `clarify.md`.

## Lifecycle hooks

- Wraps `window.playSong` once (`wired` guard) — installs a one-shot
  `highway._onReady` that calls `onSongReady`.
- Wraps `window.showScreen` once — calls `teardown()` on any non-player screen.

## Constants

- `OFF_CLASS` / `ON_CLASS`: Tailwind utility class strings for the stem button states.
- `COMMON_STEMS = ['guitar', 'bass', 'drums', 'vocals', 'piano', 'other']`.
- `DRIFT_THRESHOLD = 0.05` seconds.

## Risks / drift watchpoints

- **Sentinel `<span>` invariant** (Q3) — if removed, sibling plugins crash on
  `insertBefore`. Covered by an inline comment but not by an automated test.
- **`MediaElementAudioSourceNode` double-bind** — creating a second source
  for an already-bound `<audio>` throws. Teardown must always run before
  `buildGraph` for the same element.
- **AudioContext state** — the shared `ctx` is reused; `core.onplay` calls
  `ctx.resume()` to handle browsers' autoplay-block behaviour.
- **Public API consumers** — any rename in `getState()` shape ripples to
  `stem_mixer`. Track via Q8.
