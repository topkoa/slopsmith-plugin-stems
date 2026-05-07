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

    // ── Teardown ──
    function teardown() {
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
        if (container) {
            container.remove();
            container = null;
        }
        // Leave ctx alive — reusing it avoids browser "too many contexts" warnings.
    }

    // ── UI ──
    function injectUI() {
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
            btn.textContent = s.id;
            btn.title = `Click: toggle ${s.id}. Shift+click: volume.`;
            btn.className = s.on ? ON_CLASS : OFF_CLASS;
            btn.onclick = (e) => {
                if (e.shiftKey) {
                    toggleSlider(s, wrap);
                    return;
                }
                s.on = !s.on;
                s.gain.gain.value = s.on ? s.vol : 0;
                btn.className = s.on ? ON_CLASS : OFF_CLASS;
                saveMuted(currentFilename, stemState);
            };
            s.btn = btn;
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

    function toggleSlider(s, wrap) {
        const existing = wrap.querySelector('.stems-vol-popover');
        if (existing) { existing.remove(); return; }
        const pop = document.createElement('div');
        pop.className = 'stems-vol-popover';
        pop.style.cssText = 'position:absolute;bottom:100%;left:50%;transform:translateX(-50%);margin-bottom:6px;background:#13132a;border:1px solid #2a2a3e;border-radius:6px;padding:6px 8px;z-index:9999;box-shadow:0 6px 20px rgba(0,0,0,0.5);';
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0'; slider.max = '100'; slider.step = '1';
        slider.value = String(Math.round(s.vol * 100));
        slider.dataset.stem = s.id;
        slider.style.cssText = 'width:90px;vertical-align:middle;';
        slider.oninput = () => {
            s.vol = Number(slider.value) / 100;
            if (s.on) s.gain.gain.value = s.vol;
            saveVolume(currentFilename, s.id, s.vol);
        };
        slider.onclick = (e) => e.stopPropagation();
        pop.appendChild(slider);
        wrap.appendChild(pop);
        // Dismiss on outside click
        setTimeout(() => {
            const off = (ev) => {
                if (!pop.contains(ev.target) && ev.target !== s.btn) {
                    pop.remove();
                    document.removeEventListener('click', off, true);
                }
            };
            document.addEventListener('click', off, true);
        }, 0);
    }

    // ── Core audio sync ──
    function hookCoreAudio() {
        const core = document.getElementById('audio');
        if (!core) return;

        // Core element is the timing master — silent.
        core.volume = 0;

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

            const vol = (typeof savedVols[s.id] === 'number') ? savedVols[s.id] : 1;
            gain.gain.value = on ? vol : 0;
            source.connect(gain).connect(ctx.destination);

            return { id: s.id, url: s.url, default: s.default, audio, source, gain, on, vol };
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

            // Wait for song_info via highway._onReady (same pattern splitscreen uses)
            const prev = highway._onReady;
            const readyFn = () => {
                try { onSongReady(); } catch (e) { console.warn('[stems] init failed:', e); }
                if (prev) prev();
                if (highway._onReady === readyFn) highway._onReady = null;
            };
            highway._onReady = readyFn;

            // If highway already fired ready (e.g. another plugin awaited
            // a slow operation in the chain), trigger immediately.
            const info = highway.getSongInfo && highway.getSongInfo();
            if (info && info.title) {
                highway._onReady = null;
                readyFn();
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
            const clamped = Math.max(0, Math.min(1, v));
            for (const s of stemState) {
                if (s.id.toLowerCase() !== target) continue;
                s.vol = clamped;
                if (s.on) s.gain.gain.value = clamped;
                saveVolume(currentFilename, s.id, clamped);
                if (container) {
                    const ranges = container.querySelectorAll('.stems-vol-popover input[type=range]');
                    for (const pop of ranges) {
                        if (pop.dataset.stem === s.id) {
                            pop.value = String(Math.round(clamped * 100));
                        }
                    }
                }
            }
        },
        setMuted(id, muted) {
            const m = coerceBool(muted);
            const target = String(id).toLowerCase();
            for (const s of stemState) {
                if (s.id.toLowerCase() !== target) continue;
                s.on = !m;
                s.gain.gain.value = s.on ? s.vol : 0;
                if (s.btn) s.btn.className = s.on ? ON_CLASS : OFF_CLASS;
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
            if (!(key in existing)) {
                Object.defineProperty(existing, key, desc[key]);
            }
        }
    }

    installHooks();
})();
