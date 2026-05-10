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
    const claimSnapshots = new Map();  // claimId:stemId -> previous session-only state
    // Pending poll fallback for the cold-load race. Tracked at module
    // scope so teardown() can cancel it whenever the previous play is
    // abandoned (new song, or leaving the player), preventing an
    // orphaned interval from firing onSongReady() out of context for
    // the wrong song or after the player is gone.
    let pollHandle = null;

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
        claimSnapshots.clear();
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
                recordStemUserOverride(s, 'User toggled Stems mute');
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
        if (stems.length === 0) { emitStemsState('provider-ready', { stemCount: 0 }); return; } // PSARC or stem-less sloppak — do nothing
        buildGraph(stems);
        hookCoreAudio();
        injectUI();
        emitStemsState('provider-ready', { stemCount: stemState.length, stemIds: stemState.map(s => s.id) });

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
        const hookState = window.__slopsmithStemsHooks || (window.__slopsmithStemsHooks = {});
        hookState.impl = {
            beforePlaySong(f) {
                teardown(); // kill any prior graph before new song loads
                currentFilename = f;
            },
            afterPlaySong(f) {
                const myFile = f;
                if (currentFilename !== myFile) return;
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
                        const info = highway.getSongInfo && highway.getSongInfo();
                        if (info && info.title && Array.isArray(info.stems)) {
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
            },
            teardown,
        };
        if (hookState.installed) return;
        wired = true;
        hookState.installed = true;

        const _play = window.playSong;
        hookState.basePlaySong = _play;
        window.playSong = async function (f, a) {
            const beforeImpl = hookState.impl;
            if (beforeImpl && typeof beforeImpl.beforePlaySong === 'function') beforeImpl.beforePlaySong(f, a);
            await hookState.basePlaySong.call(this, f, a);
            const afterImpl = hookState.impl;
            if (afterImpl && typeof afterImpl.afterPlaySong === 'function') afterImpl.afterPlaySong(f, a);
        };

        // Clean up on leaving the player
        const _show = window.showScreen;
        hookState.baseShowScreen = _show;
        window.showScreen = function (id) {
            const impl = hookState.impl;
            if (id !== 'player' && impl && typeof impl.teardown === 'function') impl.teardown();
            return hookState.baseShowScreen.call(this, id);
        };
    }

    // Coerce common non-boolean inputs ('false', '0', 0, '', null) to false
    // so external callers can't accidentally mute by passing a string.
    function coerceBool(v) {
        if (v === 'false' || v === '0' || v === '' || v == null) return false;
        return Boolean(v);
    }

    function capabilityApi() {
        return window.slopsmith && window.slopsmith.capabilities;
    }

    function isGuitarStemId(id) {
        return /(^|[-_\s])(guitars?|rhythm|lead|dist|distortion)([-_\s]|$)/i.test(String(id || ''));
    }

    function applyStemState(stem, on, vol = stem.vol) {
        stem.vol = Math.max(0, Math.min(1, Number.isFinite(Number(vol)) ? Number(vol) : stem.vol));
        stem.on = !!on;
        stem.gain.gain.value = stem.on ? stem.vol : 0;
        if (stem.btn) stem.btn.className = stem.on ? ON_CLASS : OFF_CLASS;
    }

    function emitStemsState(event, payload = {}) {
        const detail = { event, filename: currentFilename, ...payload };
        try { window.dispatchEvent(new CustomEvent('stems:state', { detail })); } catch (_) {}
        const api = capabilityApi();
        if (api && typeof api.emitEvent === 'function') {
            api.emitEvent('stems', event === 'provider-ready' ? 'stems.ready' : event, detail);
        }
    }

    function stemSelector(stem) {
        return isGuitarStemId(stem && stem.id) ? 'guitar' : String(stem && stem.id || '*').toLowerCase();
    }

    function recordStemUserOverride(stem, reason) {
        const api = capabilityApi();
        if (!api || typeof api.recordUserOverride !== 'function') return;
        api.recordUserOverride({
            capability: 'stems',
            command: 'mute',
            source: 'user',
            target: { id: stem.id, kind: stemSelector(stem) },
            selector: stemSelector(stem),
            reason,
        });
        if (typeof api.emitEvent === 'function') api.emitEvent('stems', 'stems.manual-unmute', { id: stem.id, on: stem.on, filename: currentFilename });
    }

    function capabilityTargets(payload = {}) {
        if (!stemState.length) return [];
        const target = payload.target && typeof payload.target === 'object' ? payload.target : {};
        const id = payload.id || target.id;
        if (id) return stemState.filter(s => s.id.toLowerCase() === String(id).toLowerCase());
        const selector = String(payload.selector || target.selector || target.kind || '').toLowerCase();
        if (selector === 'guitar') {
            const guitars = stemState.filter(s => isGuitarStemId(s.id));
            return guitars.length ? guitars : stemState.filter(s => String(s.id).toLowerCase() === 'other');
        }
        return stemState.slice();
    }

    function claimIdFromContext(ctx) {
        const payload = ctx && ctx.payload && typeof ctx.payload === 'object' ? ctx.payload : {};
        const claim = ctx && ctx.claim && typeof ctx.claim === 'object' ? ctx.claim : {};
        return payload.claimId || claim.claimId || null;
    }

    function capMute(ctx = {}) {
        const payload = ctx.payload || {};
        const claimId = claimIdFromContext(ctx);
        const mutedIds = [];
        for (const stem of capabilityTargets(payload)) {
            if (claimId) {
                const key = `${claimId}:${stem.id}`;
                if (!claimSnapshots.has(key)) claimSnapshots.set(key, { claimId, id: stem.id, prevOn: stem.on, prevVol: stem.vol, filename: currentFilename });
            }
            applyStemState(stem, false, stem.vol);
            mutedIds.push(stem.id);
        }
        return { outcome: 'handled', payload: { claimId, mutedIds, filename: currentFilename } };
    }

    function capRestore(ctx = {}) {
        const claimId = claimIdFromContext(ctx);
        const restoredIds = [];
        for (const [key, previous] of Array.from(claimSnapshots.entries())) {
            if (claimId && previous.claimId !== claimId) continue;
            const stem = stemState.find(s => s.id === previous.id);
            if (stem) {
                applyStemState(stem, previous.prevOn, previous.prevVol);
                restoredIds.push(stem.id);
            }
            claimSnapshots.delete(key);
        }
        return { outcome: 'handled', payload: { claimId, restoredIds, filename: currentFilename } };
    }

    function clearClaimSnapshots(claimId) {
        if (!claimId) return;
        for (const [key, previous] of Array.from(claimSnapshots.entries())) {
            if (previous.claimId === claimId) claimSnapshots.delete(key);
        }
    }

    function capSetVolume(ctx = {}) {
        const payload = ctx.payload || {};
        stemsApi.setVolume(payload.id || payload.target?.id, payload.vol ?? payload.volume);
        return { outcome: 'handled', payload: capList().payload };
    }

    function capList() {
        return { outcome: 'handled', payload: { filename: currentFilename, stems: stemsApi.getState().map(s => ({ id: s.id, vol: s.vol, on: s.on })) } };
    }

    function capInspect() {
        return { outcome: 'handled', payload: { filename: currentFilename, activeClaims: Array.from(claimSnapshots.values()), stems: capList().payload.stems } };
    }

    function installCapabilityParticipant() {
        const api = capabilityApi();
        if (!api || typeof api.registerParticipant !== 'function') {
            window.addEventListener('slopsmith:capabilities:ready', installCapabilityParticipant, { once: true });
            return;
        }
        api.registerParticipant('stems', {
            stems: {
                roles: ['owner', 'provider'],
                commands: ['mute', 'restore', 'setVolume', 'list', 'inspect', 'mute-guitar', 'unmute-guitar'],
                events: ['stems.ready', 'stems.mute-requested', 'stems.manual-unmute', 'claim:created', 'claim:released'],
                compatibility: 'legacy-window-shim',
                runtime: true,
                handlers: {
                    mute: capMute,
                    restore: capRestore,
                    setVolume: capSetVolume,
                    list: capList,
                    inspect: capInspect,
                    'mute-guitar': capMute,
                    'unmute-guitar': capRestore,
                },
                eventHandlers: {
                    'claim:released': (detail) => clearClaimSnapshots(detail && detail.payload && detail.payload.claimId),
                },
            },
        });
        emitStemsState('provider-ready', { stemCount: stemState.length, stemIds: stemState.map(s => s.id) });
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

    installCapabilityParticipant();
    installHooks();
})();
