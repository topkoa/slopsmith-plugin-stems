# Slopsmith Plugin: Stems

A plugin for [Slopsmith](https://github.com/byrongamatos/slopsmith) that turns multi-stem `.sloppak` songs into a live mixing board. Toggle guitar, bass, drums, vocals, piano, or "other" on the fly during playback, tweak each stem's volume, and the plugin remembers your mix per song.

PSARC songs are untouched — the plugin only activates when a song's `song_info` payload contains a non-empty `stems[]` array.

## Features

- **Per-stem mute toggles** injected into the player control bar
- **Volume sliders** — shift+click any stem button to open a volume popover
- **Per-song memory** — muted stems and volumes are saved to `localStorage` keyed by filename, so each song reopens with your last mix
- **Default-muted presets** — pick which stems start muted on new songs (e.g. always start with vocals off)
- **Karaoke mode** — one-click preset that always mutes vocals by default
- **Tight sync** — stems slave their `currentTime` to the core `<audio>` element on play/seek events, with a 50 ms drift threshold correction
- **Inert on PSARC** — core audio works normally when there are no stems to mix

## Installation

```bash
cd /path/to/slopsmith/plugins
git clone https://github.com/topkoa/slopsmith-plugin-stems.git stems
docker compose restart
```

## Usage

1. Convert a PSARC to a `.sloppak` with the [Sloppak Converter](https://github.com/topkoa/slopsmith-plugin-sloppak-converter) plugin (which runs Demucs to split the single mixed track into per-instrument stems), or hand-craft a sloppak directory with multiple stems listed in `manifest.yaml`.
2. Play the song. The stem mixer bar appears in `#player-controls` with one labeled button per stem.
3. Click a stem to toggle it on/off. Shift+click to adjust its volume.
4. Your mute state and volumes are remembered the next time you open the same song.

## Settings

Open **Settings → Stem Mixer** to configure:

- **Karaoke mode** — start every new song with vocals muted
- **Default muted stems** — tick the stems that should default to off (e.g. vocals + piano for a guitar practice preset)

Per-song toggles always override defaults.

## How it works

The plugin wraps the core `<audio id="audio">` element as a silent timing master. For each stem in the song's manifest it:

1. Creates a new `<audio>` element pointed at the stem URL
2. Wires it through a `MediaElementAudioSourceNode` → `GainNode` → `AudioContext.destination`
3. Hooks the core audio's `play` / `pause` / `seeking` / `ratechange` events to fan out to every stem
4. Corrects any drift > 50 ms on `play` events by snapping the stem back to `core.currentTime`

Toggling a stem is a pure `GainNode.gain.value` change — no element pause/unpause, no glitching. Teardown restores the core `<audio>` element cleanly when you leave the player or load a non-sloppak song.

## Requirements

Requires Slopsmith with `.sloppak` format support and a `song_info` payload that includes a `stems[]` array (available on the `feature/sloppak-format` branch and its merged descendants).

## Other Plugins

- [Sloppak Converter](https://github.com/topkoa/slopsmith-plugin-sloppak-converter) — convert PSARCs into `.sloppak` files in-app, with optional Demucs stem splitting

## License

MIT
