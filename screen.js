(function () {
    'use strict';

    /* ======================================================================
     *  Stems Toggle Plugin
     *  For sloppak songs with multiple stems, creates a Web Audio graph
     *  where each stem is its own <audio> element routed through a GainNode.
     *  The core <audio id="audio"> is used as a silent timing master and
     *  play/pause/seek events fan out to every stem element.
     *  PSARC songs (stems[] empty) are untouched.
     * ====================================================================== */

    const OFF_CLASS = 'px-2 py-1 bg-dark-600 hover:bg-dark-500 rounded-md text-[11px] text-gray-400 transition';
    const ON_CLASS  = 'px-2 py-1 bg-accent/30 hover:bg-accent/40 rounded-md text-[11px] text-accent-light transition';

    const KARAOKE_KEY = 'stemsKaraokeDefault';
    const DEFAULT_MUTED_KEY = 'stemsDefaultMuted'; // JSON array of stem ids
    const COMMON_STEMS = ['guitar', 'bass', 'drums', 'vocals', 'piano', 'other'];
    const MUTE_KEY_PREFIX = 'stemsMute:';  // per-song muted stem ids
    const VOL_KEY_PREFIX = 'stemsVol:';    // per-song volume overrides (id -> 0..1)
    const DRAG_THRESHOLD_PX = 4;
    const KEYBOARD_VOLUME_STEP = 0.02;
    const KEYBOARD_VOLUME_STEP_LARGE = 0.1;
    const PRIMARY_BUTTON_MASK = 1;

    function loadDefaultMuted() {
        try {
            const raw = localStorage.getItem(DEFAULT_MUTED_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            return new Set(Array.isArray(arr) ? arr : []);
        } catch (_) { return new Set(); }
    }
    function saveDefaultMuted(set) {
        try { localStorage.setItem(DEFAULT_MUTED_KEY, JSON.stringify([...set])); }
        catch (_) {}
    }

    function loadMuted(filename) {
        if (!filename) return null;
        try {
            const raw = localStorage.getItem(MUTE_KEY_PREFIX + filename);
            if (!raw) return null;
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? new Set(arr) : null;
        } catch (_) { return null; }
    }
    function saveMuted(filename, stemStateArr) {
        if (!filename) return;
        const muted = stemStateArr.filter(s => !s.on).map(s => s.id);
        try { localStorage.setItem(MUTE_KEY_PREFIX + filename, JSON.stringify(muted)); }
        catch (_) {}
    }
    function loadVolumes(filename) {
        if (!filename) return {};
        try {
            const raw = localStorage.getItem(VOL_KEY_PREFIX + filename);
            return raw ? (JSON.parse(raw) || {}) : {};
        } catch (_) { return {}; }
    }
    function saveVolume(filename, id, vol) {
        if (!filename) return;
        try {
            const cur = loadVolumes(filename);
            cur[id] = vol;
            localStorage.setItem(VOL_KEY_PREFIX + filename, JSON.stringify(cur));
        } catch (_) {}
    }

    // ── Plugin state ──
    let ctx = null;                    // AudioContext
    let stemState = [];                // [{ id, url, default, audio, source, gain, on }]
    let wired = false;                 // playSong hooks installed
    let container = null;              // UI container in #player-controls
    let currentFilename = null;
    // Pending poll fallback for the cold-load race. Tracked at module
    // scope so teardown() can cancel it whenever the previous play is
    // abandoned (new song, or leaving the player), preventing an
    // orphaned interval from firing onSongReady() out of context for
    // the wrong song or after the player is gone.
    let pollHandle = null;
    const pointerCleanupHandlers = new Set();

    function cleanupPointerHandlers() {
        for (const cleanup of pointerCleanupHandlers) {
            try { cleanup(); } catch (_) {}
        }
    }

    // ── Settings ──
    const karaokeToggle = document.getElementById('stems-toggle-karaoke');
    if (karaokeToggle) {
        karaokeToggle.checked = localStorage.getItem(KARAOKE_KEY) === '1';
        karaokeToggle.addEventListener('change', () => {
            localStorage.setItem(KARAOKE_KEY, karaokeToggle.checked ? '1' : '0');
        });
    }
    const defMutedHost = document.getElementById('stems-toggle-startup-muted');
    if (defMutedHost) {
        const muted = loadDefaultMuted();
        defMutedHost.innerHTML = '';
        for (const id of COMMON_STEMS) {
            const lbl = document.createElement('label');
            lbl.className = 'flex items-center gap-1.5 text-xs text-gray-300 px-2 py-1 bg-dark-700 rounded';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'accent-accent';
            cb.checked = muted.has(id);
            cb.addEventListener('change', () => {
                const cur = loadDefaultMuted();
                if (cb.checked) cur.add(id); else cur.delete(id);
                saveDefaultMuted(cur);
            });
            lbl.appendChild(cb);
            lbl.appendChild(document.createTextNode(' ' + id));
            defMutedHost.appendChild(lbl);
        }
    }
    function karaokeDefault() {
        return localStorage.getItem(KARAOKE_KEY) === '1';
    }

    function clampVolume(volume) {
        const numeric = Number(volume);
        if (!Number.isFinite(numeric)) return null;
        return Math.max(0, Math.min(1, numeric));
    }

    function updateStemButton(stem, options = {}) {
        if (!stem.btn) return;
        const volume = clampVolume(stem.vol);
        const percent = Math.round((volume == null ? 0 : volume) * 100);
        stem.btn.className = stem.on ? ON_CLASS : OFF_CLASS;
        if (options.updateA11y !== false) {
            stem.btn.title = `Click: toggle ${stem.id}. Drag left/right: set volume (${percent}%).`;
            stem.btn.setAttribute('aria-pressed', stem.on ? 'true' : 'false');
            stem.btn.setAttribute('aria-label', `${stem.id} stem, ${stem.on ? 'on' : 'muted'}, volume ${percent}%`);
        }
        if (stem.volFill) {
            stem.volFill.className = stem.on ? 'bg-accent/40' : 'bg-dark-500';
            stem.volFill.style.width = `${percent}%`;
        }
    }

    function setStemVolume(stem, volume, options = {}) {
        const clamped = clampVolume(volume);
        if (clamped == null) return false;
        const changed = stem.vol !== clamped;
        stem.vol = clamped;
        if (stem.on) stem.gain.gain.value = clamped;
        updateStemButton(stem, options);
        if (options.persist !== false && changed) saveVolume(currentFilename, stem.id, clamped);
        return true;
    }

    function setStemVolumeFromPointer(stem, button, event, options = {}, bounds = null) {
        const rect = bounds || button.getBoundingClientRect();
        if (!rect.width) return false;
        const volume = (event.clientX - rect.left) / rect.width;
        return setStemVolume(stem, volume, options);
    }

    // ── Teardown ──
    function teardown() {
        cleanupPointerHandlers();
        // Cancel any pending cold-load poll first. Without this, a poll
        // started by the previous playSong invocation keeps firing on
        // its 200ms cadence and could rebuild the graph for the wrong
        // song, or after the user has navigated away from the player.
        if (pollHandle !== null) {
            clearInterval(pollHandle);
            pollHandle = null;
        }
        // Restore the core audio element first so playback isn't interrupted
        // while we clean up.
        const core = document.getElementById('audio');
        if (core) {
            core.volume = 1;
            core.muted = false;
            core.onplay = null;
            core.onpause = null;
            core.onseeking = null;
            core.onratechange = null;
        }
        for (const s of stemState) {
            try { s.audio.pause(); } catch (_) {}
            try { s.source && s.source.disconnect(); } catch (_) {}
            try { s.gain && s.gain.disconnect(); } catch (_) {}
            s.audio.src = '';
            s.audio.remove();
        }
        stemState = [];
        pointerCleanupHandlers.clear();
        if (container) {
            container.remove();
            container = null;
        }
        // Leave ctx alive — reusing it avoids browser "too many contexts" warnings.
    }

    // ── UI ──
    function injectUI() {
        cleanupPointerHandlers();
        pointerCleanupHandlers.clear();
        const c = document.getElementById('player-controls');
        if (!c) return;
        // Remove any previous bar
        const prev = document.getElementById('stems-mixer');
        if (prev) prev.remove();

        container = document.createElement('div');
        container.id = 'stems-mixer';
        container.className = 'flex items-center gap-1.5';
        container.style.cssText = 'padding:0 6px;border-left:1px solid #2a2a3e;margin-left:4px;';

        const label = document.createElement('span');
        label.textContent = 'Stems';
        label.style.cssText = 'font-size:10px;color:#6b7280;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;margin-right:4px;';
        container.appendChild(label);

        for (const s of stemState) {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'position:relative;display:inline-block;';

            const btn = document.createElement('button');
            btn.style.cssText = 'position:relative;overflow:hidden;min-width:46px;touch-action:none;';
            const fill = document.createElement('span');
            fill.style.cssText = 'position:absolute;left:0;top:0;bottom:0;width:0%;pointer-events:none;transition:width 80ms linear,background-color 120ms ease,border-color 120ms ease;';
            const text = document.createElement('span');
            text.textContent = s.id;
            text.style.cssText = 'position:relative;z-index:1;pointer-events:none;';
            btn.appendChild(fill);
            btn.appendChild(text);
            s.btn = btn;
            s.volFill = fill;

            let volumeGestureActive = false;
            let volumePointerId = null;
            let pointerTracking = false;
            let hasPointerCapture = false;
            let pointerStartX = 0;
            let pointerStartY = 0;
            let pointerBounds = null;
            let pointerFilename = null;
            let pointerStartVolume = null;
            let suppressNextClick = false;
            const clearPointerState = () => {
                pointerTracking = false;
                volumeGestureActive = false;
                volumePointerId = null;
                hasPointerCapture = false;
                pointerBounds = null;
                pointerFilename = null;
                pointerStartVolume = null;
                window.removeEventListener('pointerup', finishVolumeGesture);
                window.removeEventListener('pointercancel', finishVolumeGesture);
                window.removeEventListener('pointermove', handleVolumePointerMove);
            };
            pointerCleanupHandlers.add(clearPointerState);
            const handleVolumePointerMove = (event) => {
                if (!pointerTracking || event.pointerId !== volumePointerId) return;
                if (!hasPointerCapture && event.currentTarget !== window) return;
                if (!hasPointerCapture && (event.buttons & PRIMARY_BUTTON_MASK) === 0) {
                    clearPointerState();
                    return;
                }
                const deltaX = event.clientX - pointerStartX;
                const deltaY = event.clientY - pointerStartY;
                if (!volumeGestureActive) {
                    if (Math.abs(deltaX) < DRAG_THRESHOLD_PX || Math.abs(deltaX) < Math.abs(deltaY)) return;
                    volumeGestureActive = true;
                    suppressNextClick = true;
                }
                event.preventDefault();
                setStemVolumeFromPointer(s, btn, event, { persist: false, updateA11y: false }, pointerBounds);
            };
            btn.addEventListener('pointerdown', (event) => {
                if (event.button !== 0) return;
                pointerTracking = true;
                volumeGestureActive = false;
                volumePointerId = event.pointerId;
                pointerStartX = event.clientX;
                pointerStartY = event.clientY;
                const rect = btn.getBoundingClientRect();
                pointerBounds = { left: rect.left, width: rect.width };
                pointerFilename = currentFilename;
                pointerStartVolume = s.vol;
                suppressNextClick = false;
                try {
                    btn.setPointerCapture(event.pointerId);
                    hasPointerCapture = true;
                } catch (_) {
                    hasPointerCapture = false;
                    window.addEventListener('pointerup', finishVolumeGesture);
                    window.addEventListener('pointercancel', finishVolumeGesture);
                    window.addEventListener('pointermove', handleVolumePointerMove);
                }
            });
            btn.addEventListener('pointermove', handleVolumePointerMove);
            const finishVolumeGesture = (event) => {
                if (!pointerTracking || event.pointerId !== volumePointerId) return;
                if (!hasPointerCapture && event.currentTarget !== window && event.type !== 'lostpointercapture') return;
                if (volumeGestureActive) {
                    if (event.type === 'pointerup') {
                        event.preventDefault();
                        setStemVolumeFromPointer(s, btn, event, { persist: false }, pointerBounds);
                        saveVolume(pointerFilename, s.id, s.vol);
                        setTimeout(() => { suppressNextClick = false; }, 0);
                    } else {
                        setStemVolume(s, pointerStartVolume, { persist: false });
                        suppressNextClick = false;
                    }
                }
                clearPointerState();
                try { btn.releasePointerCapture(event.pointerId); } catch (_) {}
            };
            btn.addEventListener('pointerup', finishVolumeGesture);
            btn.addEventListener('pointercancel', finishVolumeGesture);
            btn.addEventListener('lostpointercapture', finishVolumeGesture);
            btn.addEventListener('keydown', (event) => {
                let direction = 0;
                if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') direction = -1;
                if (event.key === 'ArrowRight' || event.key === 'ArrowUp') direction = 1;
                if (!direction) return;
                event.preventDefault();
                const step = event.shiftKey ? KEYBOARD_VOLUME_STEP_LARGE : KEYBOARD_VOLUME_STEP;
                setStemVolume(s, s.vol + (direction * step));
            });

            btn.onclick = (event) => {
                if (suppressNextClick) {
                    event.preventDefault();
                    event.stopPropagation();
                    return;
                }
                s.on = !s.on;
                s.gain.gain.value = s.on ? s.vol : 0;
                updateStemButton(s);
                saveMuted(currentFilename, stemState);
            };
            setStemVolume(s, s.vol, { persist: false });
            wrap.appendChild(btn);
            // Sentinel keeps btn from being button:last-child of wrap.
            // Several other plugins (tones, drums, fretboard, midi, ...)
            // locate the close button via controls.querySelector('button:last-child')
            // and then insertBefore(newBtn, closeBtn). Without this sentinel
            // a nested stem button matches first and the insertBefore call
            // throws NotFoundError because the resolved node isn't a direct
            // child of controls.
            const sentinel = document.createElement('span');
            sentinel.style.display = 'none';
            wrap.appendChild(sentinel);
            container.appendChild(wrap);
        }

        // Insert before the separator span, same pattern invert uses
        const separator = c.querySelector('span.text-gray-700');
        if (separator) c.insertBefore(container, separator);
        else c.appendChild(container);
    }

    // ── Core audio sync ──
    function hookCoreAudio() {
        const core = document.getElementById('audio');
        if (!core) return;

        // Core element is the timing master — silent.
        // Set BOTH .volume = 0 and .muted = true. The volume mute alone
        // gets stomped by app.js's `loadedmetadata` listener (added for
        // slopsmith#54) which re-applies the user's saved song volume
        // every time the audio element loads metadata — including when
        // it loads stems[0].url for the timing master. .muted is a
        // separate flag that listener doesn't touch, so it survives.
        // teardown() restores both.
        core.volume = 0;
        core.muted = true;

        const DRIFT_THRESHOLD = 0.05; // 50 ms — seek stems back in sync on play

        core.onplay = () => {
            if (ctx && ctx.state === 'suspended') ctx.resume();
            for (const s of stemState) {
                if (Math.abs(s.audio.currentTime - core.currentTime) > DRIFT_THRESHOLD) {
                    s.audio.currentTime = core.currentTime;
                }
                const p = s.audio.play();
                if (p && p.catch) p.catch(() => {});
            }
        };
        core.onpause = () => {
            for (const s of stemState) {
                try { s.audio.pause(); } catch (_) {}
            }
        };
        core.onseeking = () => {
            for (const s of stemState) {
                try { s.audio.currentTime = core.currentTime; } catch (_) {}
            }
        };
        core.onratechange = () => {
            for (const s of stemState) {
                s.audio.playbackRate = core.playbackRate;
            }
        };
    }

    // ── Build graph for a sloppak ──
    function buildGraph(stems) {
        if (!ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            ctx = new AC();
        }

        const karaoke = karaokeDefault();
        const defaultMuted = loadDefaultMuted();
        const savedMuted = loadMuted(currentFilename);
        const savedVols = loadVolumes(currentFilename);

        stemState = stems.map((s) => {
            const audio = new Audio();
            audio.crossOrigin = 'anonymous';
            audio.preload = 'auto';
            audio.src = s.url;
            audio.onerror = (e) => console.error(`[stems] Failed to load ${s.id}:`, audio.error);
            audio.oncanplaythrough = () => console.log(`[stems] ${s.id} ready`);
            audio.load();

            const source = ctx.createMediaElementSource(audio);
            const gain = ctx.createGain();

            // Decide initial on/off: saved per-song state wins; then default-muted preset;
            // then karaoke override; then manifest default.
            let on;
            if (savedMuted) {
                on = !savedMuted.has(s.id);
            } else {
                on = !!s.default;
                if (defaultMuted.has(s.id)) on = false;
                if (karaoke && /vocal/i.test(s.id)) on = false;
            }

            const vol = clampVolume(savedVols[s.id]);
            const initialVol = vol ?? 1;
            gain.gain.value = on ? initialVol : 0;
            source.connect(gain).connect(ctx.destination);

            return { id: s.id, url: s.url, default: s.default, audio, source, gain, on, vol: initialVol };
        });
    }

    // ── Main entry: called after song_info arrives ──
    function onSongReady() {
        const info = highway.getSongInfo && highway.getSongInfo();
        const stems = (info && info.stems) || [];
        teardown();
        if (stems.length === 0) return; // PSARC or stem-less sloppak — do nothing
        buildGraph(stems);
        hookCoreAudio();
        injectUI();

        // The core <audio> was already pointed at stems[0].url by highway.js.
        // Keep it as the timing master but muted, and let stems[0] play via
        // our own audio element. If playback has already started, re-sync.
        const core = document.getElementById('audio');
        if (core && !core.paused) {
            for (const s of stemState) {
                s.audio.currentTime = core.currentTime;
                const p = s.audio.play();
                if (p && p.catch) p.catch(() => {});
            }
        }
    }

    // ── Hook playSong ──
    function installHooks() {
        if (wired) return;
        wired = true;

        const _play = window.playSong;
        window.playSong = async function (f, a) {
            teardown(); // kill any prior graph before new song loads
            currentFilename = f;
            await _play(f, a);

            // Three independent paths to fire onSongReady, all protected
            // by `handled` so we only build the graph once. Three paths
            // because the wrapper chain can lose either the synchronous
            // fast-path OR the _onReady hook depending on timing:
            //
            //   (1) _onReady hook — normal path. Fires when 'ready' WS
            //       message arrives AFTER we set the hook.
            //   (2) Synchronous fast-path — info.title AND info.stems
            //       are already there when our wrapper resumes (e.g. an
            //       inner async wrapper held the chain long enough that
            //       song_info already arrived). Gating on stems too
            //       avoids the partial-info trap where title is set but
            //       stems hasn't been populated yet — onSongReady would
            //       see empty stems and bail.
            //   (3) Poll fallback — covers the race where 'ready' fires
            //       AFTER inner wrappers' awaits resolved but BEFORE we
            //       reach this post-await code, so _onReady was null at
            //       fire time and the hook never runs. Splitscreen
            //       documents the same race in its CLAUDE.md. Without
            //       (3), stems gets stuck on the first cold-load whenever
            //       inner wrappers (e.g. midi_capo's tuning fetch) add
            //       enough latency that ready beats us to setting
            //       _onReady.
            // Closure-captured filename for stale-play detection. teardown()
            // (called at the top of the next playSong invocation, or when
            // leaving the player) will clearInterval our poll, but in case
            // of a race where the interval ticks before teardown lands the
            // myFile guard belt-and-suspenders against firing for the
            // wrong song.
            const myFile = f;
            let handled = false;
            const fire = () => {
                if (handled) return;
                if (currentFilename !== myFile) return;
                handled = true;
                try { onSongReady(); } catch (e) { console.warn('[stems] init failed:', e); }
            };
            const prev = highway._onReady;
            const readyFn = () => {
                fire();
                if (prev) prev();
                if (highway._onReady === readyFn) highway._onReady = null;
            };
            highway._onReady = readyFn;

            const infoNow = highway.getSongInfo && highway.getSongInfo();
            if (infoNow && infoNow.title && Array.isArray(infoNow.stems)) {
                highway._onReady = null;
                fire();
                if (prev) prev();
            } else {
                let attempts = 0;
                let myHandle;
                myHandle = setInterval(() => {
                    attempts++;
                    if (handled || currentFilename !== myFile || attempts >= 30) {
                        clearInterval(myHandle);
                        if (pollHandle === myHandle) pollHandle = null;
                        return;
                    }
                    const i = highway.getSongInfo && highway.getSongInfo();
                    if (i && i.title && Array.isArray(i.stems)) {
                        clearInterval(myHandle);
                        if (pollHandle === myHandle) pollHandle = null;
                        if (!handled) {
                            if (highway._onReady === readyFn) highway._onReady = null;
                            fire();
                            if (prev) prev();
                        }
                    }
                }, 200);
                pollHandle = myHandle;
            }
        };

        // Clean up on leaving the player
        const _show = window.showScreen;
        window.showScreen = function (id) {
            if (id !== 'player') teardown();
            return _show(id);
        };
    }

    // Coerce common non-boolean inputs ('false', '0', 0, '', null) to false
    // so external callers can't accidentally mute by passing a string.
    function coerceBool(v) {
        if (v === 'false' || v === '0' || v === '' || v == null) return false;
        return Boolean(v);
    }

    /**
     * Public API exposed at window.stems for other plugins (e.g. stem_mixer).
     *
     *   getState()           Returns [{id, vol, on, gain, audio}, ...] for the
     *                        current song's stems. `gain` and `audio` are LIVE
     *                        references — callers may mutate gain.gain.value
     *                        directly, but should re-fetch on every song:loaded
     *                        because nodes are torn down between songs.
     *   setVolume(id, vol)   `id` is matched case-insensitively against stem
     *                        ids. `vol` is a float in [0, 1] — values outside
     *                        the range are clamped, NaN/undefined are ignored.
     *   setMuted(id, muted)  `muted=true` mutes, `false` unmutes. Common
     *                        non-boolean inputs ('false', '0', '', null, 0)
     *                        are coerced to false; everything else is truthy.
     *   stemState            Live array of internal stem-state objects. Same
     *                        live-reference contract as getState().
     */
    const stemsApi = {
        getState: () => stemState.map(s => ({
            // gain and audio are intentionally live references — stem_mixer
            // mutates `item.gain.gain.value` directly. Do not snapshot.
            id: s.id, vol: s.vol, on: s.on, gain: s.gain, audio: s.audio,
        })),
        setVolume(id, vol) {
            const v = Number(vol);
            if (!Number.isFinite(v)) return;
            const target = String(id).toLowerCase();
            for (const s of stemState) {
                if (s.id.toLowerCase() !== target) continue;
                setStemVolume(s, v);
            }
        },
        setMuted(id, muted) {
            const m = coerceBool(muted);
            const target = String(id).toLowerCase();
            for (const s of stemState) {
                if (s.id.toLowerCase() !== target) continue;
                s.on = !m;
                s.gain.gain.value = s.on ? s.vol : 0;
                updateStemButton(s);
                saveMuted(currentFilename, stemState);
            }
        },
    };
    Object.defineProperty(stemsApi, 'stemState', {
        get: () => stemState, enumerable: true,
    });

    // Don't clobber an existing window.stems set by another plugin —
    // only fill slots that aren't already defined, leaving any existing
    // implementations (and accessors) intact. If something non-object
    // is squatting on the global, replace it wholesale.
    const existing = window.stems;
    const isMergeable = existing && (typeof existing === 'object' || typeof existing === 'function');
    if (!isMergeable) {
        window.stems = stemsApi;
    } else {
        const desc = Object.getOwnPropertyDescriptors(stemsApi);
        for (const key of Object.keys(desc)) {
            if (key in existing) continue;
            try {
                Object.defineProperty(existing, key, desc[key]);
            } catch (err) {
                // existing is sealed/frozen or the slot is non-configurable —
                // we can't install our method here, but other slots may still
                // succeed. Don't let it break plugin init; just log so a
                // partially-installed API is observable during debugging.
                console.warn(`[stems] could not install window.stems.${key}:`, err);
            }
        }
    }

    installHooks();
})();
