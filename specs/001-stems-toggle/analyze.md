# Analyze — Stems Toggle

## Coverage

| Area                  | Spec | Plan | Code              | Notes                                 |
|-----------------------|------|------|-------------------|---------------------------------------|
| Manifest              | ✅   | ✅   | `plugin.json`     | Minimal — no nav, no routes           |
| Web Audio graph       | ✅   | ✅   | `screen.js`       | Per-stem `<audio>` + `GainNode`       |
| Player UI injection   | ✅   | ✅   | `screen.js`       | One button per stem; sentinel guard   |
| Volume popover        | ✅   | ✅   | `screen.js`       | Shift+click, outside-click dismiss    |
| Settings panel        | ✅   | ✅   | `settings.html` + JS | Karaoke + Mute-on-load              |
| Per-song persistence  | ✅   | ✅   | `screen.js`       | `stemsMute:` / `stemsVol:` prefixes   |
| Sync to core          | ✅   | ✅   | `screen.js`       | onplay/pause/seeking/ratechange       |
| Public `window.stems` | ✅   | ✅   | `screen.js`       | Merge into existing global            |
| Tests                 | ❌   | ❌   | —                 | None automated                        |

## Drift

- README "How it works" matches the implementation step-by-step.
- README claims `MediaElementAudioSourceNode → GainNode → destination` — code
  matches.
- README mentions `feature/sloppak-format` core branch — relevant to operators
  installing on older cores. Could add a runtime check that emits a console
  warning when `song_info` payloads never include `stems[]` (suggests an old
  core).

## Gaps

1. **No `subscribe` event channel** for the public API (Q8). Consumers poll.
2. **Mute-on-load checklist is closed-world** — only `COMMON_STEMS`.
3. **Filename collisions** between songs in different folders share state.
4. **No diagnostic toggle** — debugging stem desync requires devtools breakpoints
   and console logging.
5. **AudioContext is module-singleton** — sharing it with other plugins
   (e.g. `stem_mixer`'s autolevel analyser) is intentional but undocumented.

## Recommendations

- **Document the `window.stems` API** in this repo's README (currently only
  documented inline in `screen.js`).
- **Add a `subscribe` channel** for change events. Two consumers exist today
  (`stem_mixer`, future devtools); a small EventTarget would unblock them.
- **Expose a debug overlay** behind a query string (e.g. `?stems_debug=1`)
  that prints drift, current gain, and per-stem readyState.
- **Detect old cores**: when `playSong` runs but `song_info` consistently lacks
  `stems[]`, `console.warn` once with a link to the format requirement.
- **Rename collisions**: when two songs hash to the same filename, fall back
  to `filename + size + duration` or a content hash. Optional; fixes a class
  of edge cases.
