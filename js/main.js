/* MiViAm — Mike's Vintage Ambient
 * Vanilla JS (no jQuery). Notes come from a buffer-based [T][N][T] sampler
 * (7 instruments × 12 mono root samples, pitch-shifted ±1 semitone via
 * AudioBufferSourceNode.playbackRate; chromatic coverage F#1/42 … F4/77) in
 * one of two MODES: "chord" (default) walks a chord wheel — 3 min of single
 * chord tones, then a brief silent gap (one note's ring-out, so two chords
 * never overlap), then the next random chord — "classic"
 * recreates the original ambient texture with a single note (G, random
 * octave). Per-instrument volume (0–100; 0 = off), stereo balance (1–101,
 * 51 = centre) and pan width (0–100) apply per note in both modes.
 * Vinyl bed slider is 0–100 mapping onto 1%–50% volume; the bed is PAUSED
 * whenever it would be inaudible (slider 0 or master 0) — the
 * ghost keep-alive below holds the media session in its place. The bed is a
 * single element instance of the noise file, played through a Web Audio
 * GainNode so the level is linear on every browser (Firefox desktop tapers
 * element.volume perceptually).
 * A ghost keep-alive track (#keepAliveLoop, a silent FILE, never routed
 * through the AudioContext) plays whenever the app plays so the OS keeps an
 * audible media session alive even if it suspends Web Audio in the
 * background (iOS lock screen); navigator.audioSession.type = "playback"
 * (Safari 16.4+) declares the same intent where supported.
 */
(function () {
	"use strict";

	/* ---------- tiny helpers (replace jQuery) ---------- */
	function qs(sel) { return document.querySelector(sel); }
	function qsa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

	/* ---------- persistence (localStorage, with one-time legacy-cookie migration) ---------- */
	// Settings used to live in cookies; they now live in localStorage. lsGet falls
	// back to a legacy cookie once — migrating it into localStorage and clearing the
	// cookie — so returning users keep their saved mix with no visible change. Every
	// access is try-wrapped so blocked/full storage never breaks the app (it just
	// won't persist, the same graceful outcome as a blocked cookie).
	function lsSet(name, value) {
		try { localStorage.setItem(name, String(value)); } catch (e) {}
	}
	function lsGet(name) {
		try {
			var v = localStorage.getItem(name);
			if (v !== null) { return v; }
		} catch (e) {}
		var c = legacyCookieGet(name);
		if (c !== null) { lsSet(name, c); legacyCookieClear(name); }
		return c;
	}
	function legacyCookieGet(name) {
		var m = document.cookie.match(
			"(?:^|; )" + name.replace(/([.*+?^${}()|[\]\\])/g, "\\$1") + "=([^;]*)"
		);
		return m ? decodeURIComponent(m[1]) : null;
	}
	function legacyCookieClear(name) {
		try { document.cookie = name + "=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/"; } catch (e) {}
	}

	/* ---------- state ---------- */
	var instrumentsEnabled = false; // any instrument volume > 0?
	var audioEnabled = false;
	var soundPlayerArray = [];
	var sleepEndTime;
	var sleepInterval;
	var isAnimating = false;
	var settingsOpen = false;       // advanced-settings panel open? (gates the fader flash)
	var vinyl;                      // #vinylLoop element (the single vinyl bed)
	var ghost;                      // #keepAliveLoop element (silent keep-alive bed)

	// Default slider values (restoreState fallback + the "Default" preset).
	// Volumes and pan widths are the user's 2026-06-10 mix.
	var INSTRUMENT_DEFAULTS = {
		bassVol: "100",
		fluteVol: "50", rhodesVol: "100", vibesVol: "80",
		celesteVol: "30",
		celloVol: "40", violinsVol: "5", choirVol: "10"
	};
	var BALANCE_DEFAULT = "51";     // 1–101; 51 = centre (displays as "0")
	// Pan width is per-instrument (0–100): every instrument scatters up to
	// 25 either side of its balance position (user defaults 2026-06-12).
	var PAN_WIDTH_DEFAULTS = {
		bassPanWidth: "25",
		flutePanWidth: "25", rhodesPanWidth: "25",
		vibesPanWidth: "25", celestePanWidth: "25", celloPanWidth: "25", violinsPanWidth: "25",
		choirPanWidth: "25"
	};
	var VINYL_DEFAULT = "20";       // 101-position scale (user 2026-06-16: 15 -> 33 -> 20; matches all presets)
	var MASTER_DEFAULT = "100";     // master volume percent (0–100)
	var TOTAL_SOUNDS_DEFAULT = "5";   // chimes; capped at 5 globally (user 2026-06-15: dropdown max + default lowered 7->5). Was "7".
	var MODE_DEFAULT = "chord";     // playback mode: "chord" | "classic" (user 2026-06-10)

	// Global output HEADROOM (user 2026-06-11; reclaimed to 1.0 on 2026-06-15):
	// several ~5 s notes ring at once and their gains SUM at the destination, so
	// full-scale settings could clip. Headroom is now ×1.0 (NO attenuation) — the
	// master-bus limiter below (threshold lowered to −6 dB) is the safety net that
	// catches the stacked-note peaks the old ×0.9 (≈ −1 dB) trim used to prevent.
	// Still MULTIPLICATIVE, so it scales the whole mix if ever re-trimmed. UI 0–100.
	var MASTER_HEADROOM = 1.0;

	// Master-bus safety limiter (user 2026-06-13; threshold lowered 2026-06-15):
	// a single DynamicsCompressorNode sits between the WHOLE Web Audio mix (every
	// instrument note + both vinyl beds) and the destination — the ghost keep-alive
	// element is never routed through the context, so it is untouched. It is a
	// SAFETY net, not a loudness tool: the Web Audio compressor applies only
	// attenuation (no makeup gain), so below the threshold it is unity/transparent
	// and it can only ever pull peaks DOWN, never push them up. Now that the ×0.9
	// headroom above is reclaimed to ×1.0, the limiter is the PRIMARY clip guard:
	// at −6 dB it actively catches the peaks the headroom used to prevent, engaging
	// when several ~5 s notes stack toward 0 dBFS. A still-modest threshold +
	// limiting ratio + a smooth release keep it from pumping the slow ambient
	// texture. One node, created once on the bus (NOT per note), so it adds nothing
	// to the v129/v140 per-note teardown surface. Values are tunable here.
	var LIMITER_THRESHOLD_DB = -6;   // dB — catches stacked-note peaks (was −3; lowered when headroom reclaimed to ×1.0)
	var LIMITER_KNEE_DB = 3;         // dB — gentle onset (knee spans threshold ±1.5 dB)
	var LIMITER_RATIO = 12;          // limiting, not gentle compression
	var LIMITER_ATTACK_S = 0.003;    // s — fast enough to catch a stacked-note peak
	var LIMITER_RELEASE_S = 0.25;    // s — smooth release; no pumping on the ambient bed

	// Master volume (0–100%) scales EVERYTHING — the whole instrument mix and the
	// vinyl bed — on top of their own sliders (× the headroom above). It is applied
	// as the master FADER: a single post-delay node for the instrument bus
	// (masterVolNode, see instrumentBusTarget) and the vinyl bed's own gain.
	function masterScale() {
		var el = qs("#masterVol");
		var v = el ? parseInt(el.value, 10) : 100;
		return (isNaN(v) ? 1 : v / 100) * MASTER_HEADROOM;
	}

	// Slider scales (user spec 2026-06-10; vinyl rescaled 2026-06-12):
	// Instruments — 101 positions: 0 keeps the original "off" behaviour
	// (excluded from the rotation); 1–100 ARE the volume percentage in whole
	// points.
	// Vinyl — 101 positions, values 0–100: 0 is 0% volume and the bed is
	// PAUSED whenever it would be inaudible (slider 0 or master 0) — the
	// unrouted silent ghost element holds the background / lock-screen media
	// session in its place (see setVinylVolume /
	// vinylAudible). Values 1–100 map linearly onto 1%–50% volume (unlike the
	// instruments the value is a POSITION, not the percent — the label shows
	// the position).
	function instrumentScale(v) { return v / 100; }
	function vinylScale(v) {
		if (v <= 0) { return 0; }
		return (1 + (v - 1) * 49 / 99) / 100;   // 1 -> 1% … 100 -> 50%
	}

	// Single vinyl bed (user 2026-06-16: the second, channel-swapped, 4–9 s-delayed
	// instance was removed). It plays at the full vinylScale level (1%–50%) — the old
	// per-instance ×0.5 halving only existed to balance the decorrelated pair.

	// One-time migration of saved mixes from the legacy 21-station scale
	// (instrument 0–20 → ×5 on the 0–100 percent scale; vinyl 0–20, which
	// spanned 1%–50%, → ×2.5 rounded and clamped to the percent scale's
	// 0–32 — migrateVinylScaleV3 then carries that onward). Runs before
	// restoreState reads anything; any "mixScale" marker means the values
	// are already past this scale and must never be re-multiplied.
	function migrateScaleV2() {
		if (lsGet("mixScale") !== null) { return; }
		Object.keys(INSTRUMENT_DEFAULTS).forEach(function (id) {
			var v = parseInt(lsGet(id), 10);
			if (!isNaN(v) && v >= 0 && v <= 20) { lsSet(id, String(v * 5)); }
		});
		var vv = parseInt(lsGet("vinylVol"), 10);
		if (!isNaN(vv) && vv >= 0 && vv <= 20) {
			lsSet("vinylVol", String(Math.min(32, Math.round(vv * 2.5))));
		}
		lsSet("mixScale", "2");
	}

	// One-time migration (2026-06-12): the vinyl slider went from 34
	// positions where the value WAS the percent (0–33) to 101 positions
	// spanning 1%–50%. Saved values — the live mix AND each memory slot's
	// vinylVol — convert so everyone keeps the loudness they had: percent
	// p → position 1 + (p−1)·99/49, rounded (9 → 17, 33 → 66; 0 stays 0).
	// The "mixScale" marker moves to "3".
	function migrateVinylScaleV3() {
		if (lsGet("mixScale") === "3") { return; }
		function convert(p) {
			p = parseInt(p, 10);
			if (isNaN(p) || p <= 0) { return "0"; }
			return String(Math.min(100, Math.round(1 + (p - 1) * 99 / 49)));
		}
		var vv = parseInt(lsGet("vinylVol"), 10);
		if (!isNaN(vv) && vv >= 0 && vv <= 33) {
			lsSet("vinylVol", convert(vv));
		}
		MEMORY_SLOTS.forEach(function (n) {
			var raw = lsGet("memory" + n);
			if (!raw) { return; }
			var profile;
			try { profile = JSON.parse(raw); } catch (e) { return; }
			if (Object.prototype.hasOwnProperty.call(profile, "vinylVol")) {
				profile.vinylVol = convert(profile.vinylVol);
				lsSet("memory" + n, JSON.stringify(profile));
			}
		});
		lsSet("mixScale", "3");
	}

	/* ---------- sampler library (buffer-based note engine, v72) ---------- */
	// Both modes draw notes from ONE sampler: 7 instruments × 12 mono root
	// samples (~4.7–4.9 s mp3s in snd/, named "<Instrument> <Note>.mp3"),
	// pitch-shifted ±1 semitone via AudioBufferSourceNode.playbackRate on the
	// [T][N][T] pattern (roots every 3 semitones — user mapping 2026-06-10;
	// the E4 root joined 2026-06-11, lifting the ceiling from D4 to F4).
	// Chromatic coverage: notes 42 (F#1) … 77 (F4) on the project's own
	// note-number scale (just semitone indices — NO MIDI is involved
	// anywhere in this project). Everything is fetched and decoded up front
	// behind the loading gate; decoded mono PCM for the full library is
	// ~84 MB — the price of instant, gapless notes.
	var INSTRUMENTS = [
		{ prefix: "bass",        file: "Hofner Bass" },  // re-added 2026-06-13 (Höfner bass samples)
		{ prefix: "cello",       file: "Cello" },
		{ prefix: "rhodes",      file: "Rhodes" },
		{ prefix: "vibes",       file: "Vibes" },
		{ prefix: "celeste",     file: "Celeste M400" }, // added 2026-06-14 (Celeste M400 sample set)
		{ prefix: "flute",       file: "MKII-Flute" },  // the MKII flute set (the old "Flute *.mp3"
		                                                // recordings were retired 2026-06-13)
		{ prefix: "violins",     file: "Violins" },
		// `file` must match the on-disk names exactly (URLs are built from
		// it; the live server is case-sensitive). The choir files were
		// lowercase from v101 until the user capitalised them 2026-06-12.
		{ prefix: "choir",       file: "Choir" }
	];
	var ROOT_NOTES = [
		{ note: 43, file: "G1" },        { note: 46, file: "A_sharp_1" },
		{ note: 49, file: "C_sharp_2" }, { note: 52, file: "E2" },
		{ note: 55, file: "G2" },        { note: 58, file: "A_sharp_2" },
		{ note: 61, file: "C_sharp_3" }, { note: 64, file: "E3" },
		{ note: 67, file: "G3" },        { note: 70, file: "A_sharp_3" },
		{ note: 73, file: "C_sharp_4" }, { note: 76, file: "E4" }
	];
	var NOTE_FLOOR = 42;            // F#1 — G1 root −1 (user 2026-06-11)
	var NOTE_CEILING = 77;          // F4 — E4 root +1
	var sampleBuffers = {};         // "cello:43" -> decoded AudioBuffer
	var samplesTotal = INSTRUMENTS.length * ROOT_NOTES.length;   // library size (96); samples decode lazily now
	var maxSampleSeconds = 0;       // longest decoded buffer (drives the chord-gap length)

	// [T][N][T]: which root sample + playbackRate serves a note number. Roots
	// sit every 3 semitones, so every note in 42..77 is at most 1 semitone
	// from a root; rate = 2^(shift/12) (≈0.9439 / 1.0 / ≈1.0595 — the user's
	// samplerMapping constants, computed exactly here).
	function samplerFor(note) {
		var i, root;
		for (i = 0; i < ROOT_NOTES.length; i++) {
			root = ROOT_NOTES[i];
			if (Math.abs(note - root.note) <= 1) {
				return { rootNote: root.note, rate: Math.pow(2, (note - root.note) / 12) };
			}
		}
		return null;   // outside the covered range — callers stay within it
	}

	// decodeAudioData with both the promise AND the old WebKit callback form;
	// whichever settles first wins (Promise ignores later settles).
	function decodeBuffer(arrayBuffer) {
		return new Promise(function (resolve, reject) {
			function fail(e) { reject(e || new Error("decode failed")); }
			try {
				var p = audioCtx.decodeAudioData(arrayBuffer, resolve, fail);
				if (p && p.then) { p.then(resolve, fail); }
			} catch (e) { fail(e); }
		});
	}

	// One sample's fetch + decode, with retries: a transient hiccup must not
	// mute that note for the whole session (user 2026-06-11). Standard
	// backoff — 3 retries after the first try (4 attempts total), delays
	// ~0.5–1 s / 1–2 s / 2–4 s (exponential ×2 with 50–100% jitter so a mass
	// failure does not retry in lockstep). EVERY failure kind retries —
	// network error, HTTP status and decode error alike: all 84 files are
	// known to exist, so even a 404 here is a server hiccup, and the SW only
	// ever caches 200s, so each retry truly re-hits the network. The
	// returned promise always RESOLVES, exactly once per job, after the
	// final attempt settles.
	var SAMPLE_RETRY_MAX = 3;
	var sampleRetries = 0;   // retry attempts so far (debug — _miviam)
	var samplesFailed = 0;   // jobs given up after all retries (debug)
	var pendingLoads = {};   // key -> true while a fetch+decode is in flight (dedupe)

	// Lazy decoding + evict-on-disable (user 2026-06-14): samples are NO LONGER
	// all decoded up front. Each instrument's 12 samples are fetched + decoded the
	// first time the instrument is AUDIBLE (volume > 0) and EVICTED when it leaves
	// the mix (volume 0), so the ~84 MB decoded library tracks only the instruments
	// currently audible. The mp3 bytes are tiny + SW-cached, so the only real cost
	// is the decode; a freshly-(re)enabled instrument's first notes skip silently
	// for the fraction of a second until its buffers land — the brief warm-up the
	// user accepted (2026-06-14) when raising an instrument from 0. maxSampleSeconds is a HIGH-WATER
	// mark (only grows, never reset on evict), so the chord gap (gapMs) stays a safe
	// upper bound: a note can only ring if its buffer is decoded, and decoding raises
	// maxSampleSeconds, so gapMs always covers any ringing note — no overlap.
	function urlForRoot(instr, root) {
		return "snd/" + encodeURIComponent(instr.file + " " + root.file) + ".mp3";
	}
	// "Active" = audible in the mix: positive volume. Drives the lazy-decode set
	// (a volume-0 instrument is evicted; raising it re-decodes with a brief warm-up).
	function instrumentActive(prefix) {
		var el = document.getElementById(prefix + "Vol");
		return !!(el && parseInt(el.value, 10) > 0);
	}

	// One sample's fetch + decode, with retries (exponential backoff + jitter; the
	// SW only caches 200s so each retry re-hits the network). Stores the decoded
	// buffer ONLY if its instrument is still active when it lands (it may have been
	// evicted mid-flight — then discard, but still record maxSampleSeconds). The
	// returned promise resolves once, after the final attempt settles.
	function loadSample(url, key, prefix, attempt) {
		return fetch(url)
			.then(function (res) {
				if (!res.ok) { throw new Error(url + " -> " + res.status); }
				return res.arrayBuffer();
			})
			.then(decodeBuffer)
			.then(function (buf) {
				if (buf.duration > maxSampleSeconds) { maxSampleSeconds = buf.duration; }
				if (instrumentActive(prefix)) { sampleBuffers[key] = buf; }   // else evicted mid-load — discard
				delete pendingLoads[key];
			})
			.catch(function () {
				if (attempt > SAMPLE_RETRY_MAX) {
					samplesFailed++;
					delete pendingLoads[key];   // a later reconcile re-attempts it
					return;
				}
				sampleRetries++;
				var delay = Math.pow(2, attempt - 1) * 1000 * (0.5 + Math.random() * 0.5);
				return new Promise(function (resolve) { setTimeout(resolve, delay); })
					.then(function () { return loadSample(url, key, prefix, attempt + 1); });
			});
	}

	// Ensure all 12 of an instrument's samples are decoded (or in flight). A no-op
	// for any already-decoded or in-flight sample, so it is cheap to call often.
	function ensureInstrumentSamples(prefix) {
		if (!audioCtx) { return; }
		var instr = null, i;
		for (i = 0; i < INSTRUMENTS.length; i++) { if (INSTRUMENTS[i].prefix === prefix) { instr = INSTRUMENTS[i]; break; } }
		if (!instr) { return; }
		ROOT_NOTES.forEach(function (root) {
			var key = prefix + ":" + root.note;
			if (sampleBuffers[key] || pendingLoads[key]) { return; }
			pendingLoads[key] = true;
			loadSample(urlForRoot(instr, root), key, prefix, 1);
		});
	}

	// Free an instrument's 12 decoded buffers (GC reclaims the PCM). A pending load
	// for one of them will land and, finding the instrument inactive, discard
	// itself (see loadSample), so nothing strands.
	function evictInstrumentSamples(prefix) {
		ROOT_NOTES.forEach(function (root) {
			var key = prefix + ":" + root.note;
			if (sampleBuffers[key]) { delete sampleBuffers[key]; }
		});
	}

	// Make the decoded set track the active mix: load active instruments' samples,
	// evict inactive ones'. Debounced (scheduleReconcile) so a slider drag through
	// many values reconciles once, when it settles — not on every input event.
	function reconcileSamples() {
		INSTRUMENTS.forEach(function (instr) {
			if (instrumentActive(instr.prefix)) { ensureInstrumentSamples(instr.prefix); }
			else { evictInstrumentSamples(instr.prefix); }
		});
	}
	var reconcileTimer = null;
	function scheduleReconcile() {
		if (reconcileTimer) { clearTimeout(reconcileTimer); }
		reconcileTimer = setTimeout(function () { reconcileTimer = null; reconcileSamples(); }, 250);
	}

	// Connectivity returning is worth a fresh reconcile (re-attempts any active
	// instrument's samples that exhausted their backoff while offline).
	window.addEventListener("online", scheduleReconcile);

	/* ---------- chord engine (chord mode) + mode selection (v72) ---------- */
	// Chord mode: 3 min of single chord tones (the classic 5 s spacer + jitter
	// scheme picks one random formula tone, random octave, random enabled
	// instrument per player tick) → a brief SILENT GAP (user 2026-06-14): the
	// engine plays nothing for exactly one note's ring-out (gapMs), just long
	// enough for the outgoing chord's last notes to decay to silence so two
	// chords never overlap → the next random chord on the wheel that is not the
	// current one → repeat. (User specs 2026-06-10/11/14, bootstraps v60–v78 +
	// this session's answers. The earlier "bridge" — a transitional window of
	// voicing-pool chimes — was removed 2026-06-14 in favour of this clean gap.)
	var CHORD_STATE_MS = 180000;          // 3 min per chord at normal/mixed tempo (user 2026-06-14; was 60 s). Slow mode still ×tempoMul.
	// Classic mode's single note (v74): the "Note" dropdown picks the pitch
	// class; playback perpetuates it at a random available octave (for the
	// default G that is G1/G2/G3 — exactly the original classic behaviour).
	var CLASSIC_NOTE_DEFAULT = "G";
	var NOTE_PCS = {
		"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5,
		"F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11
	};
	// Chord quality formulas (user 2026-06-10): semitone intervals from the
	// root. Selected by the "Chord Tone" dropdown (chord mode only); applies
	// to the note pool, live.
	var CHORD_TONE_DEFAULT = "RANDOM";   // dropdown default (user 2026-06-14): each 3-min chord then picks a random tone
	var CHORD_FORMULAS = {
		MAJOR: [0, 4, 7],
		MINOR: [0, 3, 7],
		DOM_7: [0, 4, 7, 10],
		MAJ_7: [0, 4, 7, 11],
		SUS_4: [0, 5, 7]
	};
	// "Random" Chord Tone (user 2026-06-14): a dropdown choice that is NOT itself a
	// formula. When selected, each new chord (every CHORD_STATE_MS) locks in ONE
	// random formula from the five real ones, so a whole 3-min chord shares a tone
	// and the next chord re-rolls (see rollChordTone / beginChord). CHORD_TONE_KEYS =
	// the real formula keys RANDOM draws from; CHORD_TONE_FALLBACK = the concrete
	// formula used if a value never resolves (CHORD_TONE_DEFAULT is "RANDOM", which
	// is not a formula key, so it can't be the fallback).
	var CHORD_TONE_KEYS = Object.keys(CHORD_FORMULAS);   // ["MAJOR","MINOR","DOM_7","MAJ_7","SUS_4"]
	var CHORD_TONE_FALLBACK = "MAJOR";
	var currentRandomToneKey = CHORD_TONE_FALLBACK;      // the formula locked in for the current chord while RANDOM is selected
	var currentChordPc = null;            // current chord's root pitch class 0–11 (C=0; null = none / silent gap)
	var chordTimer = null;                // pending 3-min chord-state end
	var gapTimer = null;                  // pending silent-gap end (between chords)

	function currentMode() {
		var sel = qs("#modeSelect");
		return (sel && sel.value === "classic") ? "classic" : "chord";
	}

	function chordToneIsRandom() {
		var sel = qs("#chordToneSelect");
		return !!(sel && sel.value === "RANDOM");
	}
	// A valid persisted / profile chordTone is "RANDOM" or any real formula key.
	function isValidChordTone(v) {
		return v === "RANDOM" || !!CHORD_FORMULAS[v];
	}
	// The formula for the CURRENT chord. RANDOM uses this chord's locked random pick
	// (currentRandomToneKey, re-rolled per chord by rollChordTone); a fixed tone reads
	// the dropdown live. Falls back to a concrete formula — NEVER CHORD_TONE_DEFAULT,
	// which is now the non-formula "RANDOM".
	function currentChordFormula() {
		if (chordToneIsRandom()) {
			return CHORD_FORMULAS[currentRandomToneKey] || CHORD_FORMULAS[CHORD_TONE_FALLBACK];
		}
		var sel = qs("#chordToneSelect");
		return (sel && CHORD_FORMULAS[sel.value]) || CHORD_FORMULAS[CHORD_TONE_FALLBACK];
	}

	function currentClassicNote() {
		var sel = qs("#classicNoteSelect");
		return (sel && NOTE_PCS.hasOwnProperty(sel.value)) ? sel.value : CLASSIC_NOTE_DEFAULT;
	}

	// Each mode shows only its own option row: Chord Tone in chord mode, the
	// classic Note in classic mode.
	function updateChordToneVisibility() {
		var chord = currentMode() === "chord";
		var toneRow = qs("#chordToneRow");
		var noteRow = qs("#classicNoteRow");
		if (toneRow) { toneRow.style.display = chord ? "" : "none"; }
		if (noteRow) { noteRow.style.display = chord ? "none" : ""; }
	}

	// Pick a random chord root (pitch class 0–11), never equal to `avoid` — passed
	// the OUTGOING root so two chords never repeat back-to-back. `avoid` is null/
	// undefined on the first chord of a fresh start, so that one is unconstrained.
	// (Must take the root as an argument: the silent gap nulls currentChordPc
	// before the next pick, so reading the global here would defeat the no-repeat.)
	function pickNextChordPc(avoid) {
		var pc;
		do { pc = Math.floor(Math.random() * 12); } while (pc === avoid);
		return pc;
	}

	// Re-roll the per-chord random tone — only meaningful while the Chord Tone is
	// "Random"; for a fixed tone it's a no-op (currentChordFormula reads the dropdown
	// live). Called at every chord start (beginChord) so each 3-min chord gets one
	// tone, and on the dropdown change so switching INTO Random takes effect at once.
	function rollChordTone() {
		if (chordToneIsRandom()) {
			currentRandomToneKey = CHORD_TONE_KEYS[Math.floor(Math.random() * CHORD_TONE_KEYS.length)];
		}
	}

	// Begin a new chord: pick the next root (never the outgoing `avoid`; undefined =
	// unconstrained, for the first chord) AND lock in this chord's tone. Shared by the
	// fresh start and the post-gap advance so both pick root + tone identically.
	function beginChord(avoid) {
		currentChordPc = pickNextChordPc(avoid);
		rollChordTone();
	}

	// Every octave of a pitch class inside the playable range.
	function notesForPc(pc) {
		var list = [], m;
		for (m = NOTE_FLOOR; m <= NOTE_CEILING; m++) {
			if (m % 12 === pc) { list.push(m); }
		}
		return list;
	}

	function clearChordTimers() {
		if (chordTimer) { clearTimeout(chordTimer); chordTimer = null; }
		if (gapTimer) { clearTimeout(gapTimer); gapTimer = null; }
	}

	// The shortest silent gap between chords that still guarantees they NEVER
	// overlap (user 2026-06-14): exactly the longest possible note's ring-out —
	// the longest decoded sample played at the slowest playback rate (a −1-
	// semitone shift; slow mode halves the rate again, doubling the time). The
	// outgoing chord's last note can start right at the 3-min boundary, so the
	// next chord must wait this long for it to fall silent. No floor (as short as
	// the samples allow), and no tempoMul — the speedCanSlow() factor already covers Slow/Mixed.
	var SLOWEST_RATE = Math.pow(2, -1 / 12);   // ≈0.9439, a −1-semitone shift
	function gapMs() {
		var ms = Math.ceil((maxSampleSeconds / (SLOWEST_RATE * (speedCanSlow() ? SLOW_RATE : 1))) * 1000);
		// When the Delay is on, a note's LAST echo starts (taps × interval) after the
		// note, then rings for the note's own length — so the gap must wait that much
		// longer or the outgoing chord's echoes bleed into the next chord (user
		// 2026-06-14). The base gap already covers a note's ring-out; add the last
		// tap's offset. (delayOn / DELAY_* are hoisted; gapMs only runs post-Start.)
		if (delayOn()) { ms += Math.ceil(DELAY_TAP_GAINS.length * DELAY_TAP_S * 1000); }
		return ms;
	}

	// After a chord's 3 min, fall silent for one note's ring-out (gapMs) so the
	// outgoing chord's last notes decay completely before the next chord begins —
	// two chords never overlap — then advance to the next random chord on the
	// wheel. currentChordPc = null during the gap makes playSound produce nothing
	// (its chord branch bails on a null chord), so the gap is true silence.
	function startChordGap() {
		chordTimer = null;
		var prev = currentChordPc;   // remember the outgoing root before the gap nulls it…
		currentChordPc = null;       // …so the next pick can still avoid repeating it
		gapTimer = setTimeout(function () {
			gapTimer = null;
			// Stopped or switched to classic mid-gap: those paths already cleared
			// this timer + the chord, so this is belt-and-braces only.
			if (!audioEnabled || currentMode() !== "chord") { return; }
			beginChord(prev);
			chordTimer = setTimeout(startChordGap, CHORD_STATE_MS * tempoMul());
		}, gapMs());
	}

	function startChordEngine() {
		clearChordTimers();
		beginChord();
		chordTimer = setTimeout(startChordGap, CHORD_STATE_MS * tempoMul());
	}

	// Re-start the chord progression MID-CHORD with a LEADING silent gap instead
	// of an immediate new chord (user 2026-06-14). Used by Speed/Mode change + a
	// live Recall: the outgoing chord — and, with Delay on by default, its echoes
	// — is still ringing, so jumping straight into startChordEngine() (which picks
	// a new root and plays at once) briefly overlaps two chords. Routing through
	// startChordGap() instead nulls the current chord immediately (playSound's
	// chord branch then bails, so none of its remaining notes are scheduled),
	// waits gapMs() for the ringing notes/echoes to decay, then advances to the
	// next root (avoiding the outgoing one) and arms the normal 3-min cycle — the
	// SAME clean gap the engine already inserts at every 3-min chord boundary.
	// MUST run with the current chord still in currentChordPc (callers therefore
	// no longer null it first) so startChordGap can read it as the no-repeat
	// `prev`; a null current (e.g. switching in from classic) just leaves the
	// next pick unconstrained. gapMs() reads the controls live, so it reflects the
	// just-applied Speed/Delay; a Recall that turns Delay OFF mid-chord is the one
	// bounded residue — the gap then covers the dry note tail but not the outgoing
	// echoes — far smaller than today's zero-gap overlap.
	function restartChordGap() {
		clearChordTimers();
		startChordGap();
	}

	/* ---------- "now playing" title flash (advanced settings open only) ---------- */
	// When an instrument sound plays AND the settings panel is open, JUST the
	// instrument's NAME (the .instrumentName span — not the colon, value, or
	// surrounding whitespace) glows yellow (CSS .playing) for FLASH_MS; a
	// replay re-arms the SAME timer. The span is found via the value span
	// (sliderId + "Val"): its parent is the label div, which contains the one
	// .instrumentName. Exactly one timer per name, kept on the element, always
	// cleared before it is re-set and on panel close — so the number of live
	// timers is bounded by the 7 instruments and nothing accumulates, making
	// it leak-free on every target platform. Vinyl and the Balance / Pan width
	// sub-rows are intentionally excluded.
	var FLASH_MS = 2000;

	function titleFor(sliderId) {
		// The instrument's name span lives in the title row at the top of the
		// .instrumentControl block (the volume slider's labels just say
		// "Volume:" since v46), so resolve it from the block, not the label.
		var slider = document.getElementById(sliderId);
		var block = slider && slider.closest ? slider.closest(".instrumentControl") : null;
		return block ? block.querySelector(".instrumentName") : null;
	}

	function flashTitle(sliderId) {
		var title = titleFor(sliderId);
		if (!title) { return; }
		if (title._flashTimer) { clearTimeout(title._flashTimer); }   // re-arm, never stack
		title.classList.add("playing");
		title._flashTimer = setTimeout(function () {
			title.classList.remove("playing");
			title._flashTimer = null;
		}, FLASH_MS);
	}

	function clearTitleFlashes() {
		qsa(".instrumentVol").forEach(function (slider) {
			var title = titleFor(slider.id);
			if (!title) { return; }
			if (title._flashTimer) { clearTimeout(title._flashTimer); title._flashTimer = null; }
			title.classList.remove("playing");
		});
	}

	/* ---------- Web Audio context + vinyl routing ---------- */
	// The AudioContext is created at page load (suspended is fine — it can
	// decode the sample library before any gesture) and resumed on the Start
	// gesture. Notes are buffer sources built per play (see playNote). Both
	// vinyl bed ELEMENT instances are routed on the first Start, through
	// plain GainNodes (no balance; the second crosses L/R through a
	// splitter/merger pair first): Firefox desktop applies .volume on an
	// UNROUTED element via the OS audio backend's stream volume, whose
	// perceptual (logarithmic) taper crushed the bed's tiny levels to
	// near-inaudible — the HTML spec allows this ("the range need not be
	// linear"), so it isn't a Firefox bug. A Web Audio gain is a spec-defined
	// LINEAR sample multiply on every browser. element.volume remains the
	// vinyl fallback whenever Web Audio is unavailable or routing fails. The
	// ghost keep-alive element is INTENTIONALLY never routed here: its job is
	// to stay a plain media element the OS treats as independent, audible
	// playback even when it suspends the AudioContext.
	var audioCtx = null;
	var vinylRouted = false;

	function ensureAudioContext() {
		if (audioCtx) { return audioCtx; }
		var AC = window.AudioContext || window.webkitAudioContext;
		if (!AC) { return null; }
		try { audioCtx = new AC(); } catch (e) { audioCtx = null; }
		return audioCtx;
	}

	// The node every voice connects to instead of audioCtx.destination: the
	// master-bus limiter (see the LIMITER_* constants). Created at most once, on
	// the first voice that needs an output, and wired straight to the
	// destination. If createDynamicsCompressor is somehow unavailable the mix
	// falls back to connecting directly to the destination (unlimited but
	// audible) — DynamicsCompressorNode is core Web Audio on every target, so
	// this is belt-and-braces only.
	var compressorNode = null;
	var appMuteGain = null;          // final master mute: 0 while stopped, 1 while playing (setAppMute)
	var masterBusTried = false;
	function masterBusTarget() {
		if (!audioCtx) { return null; }
		if (!masterBusTried) {
			masterBusTried = true;
			try {
				var c = audioCtx.createDynamicsCompressor();
				c.threshold.value = LIMITER_THRESHOLD_DB;
				c.knee.value = LIMITER_KNEE_DB;
				c.ratio.value = LIMITER_RATIO;
				c.attack.value = LIMITER_ATTACK_S;
				c.release.value = LIMITER_RELEASE_S;
				// Final master MUTE between the limiter and the destination: the WHOLE
				// mix (instruments + vinyl + ringing note/echo tails) is silenced while
				// playback is stopped and unmuted while running. The ghost keep-alive
				// element is NOT routed through here, so it still holds the media session.
				appMuteGain = audioCtx.createGain();
				appMuteGain.gain.value = audioEnabled ? 1 : 0;
				c.connect(appMuteGain);
				appMuteGain.connect(audioCtx.destination);
				compressorNode = c;
			} catch (e) { compressorNode = null; appMuteGain = null; }
		}
		return compressorNode || audioCtx.destination;
	}
	// Master mute follows playback: muted (0) while stopped, unmuted (1) while
	// running. A short ramp avoids a click when cutting the tails on Stop.
	function setAppMute(muted) {
		if (!appMuteGain || !audioCtx) { return; }
		var now = audioCtx.currentTime;
		var g = appMuteGain.gain;
		g.cancelScheduledValues(now);
		g.setValueAtTime(g.value, now);
		g.linearRampToValueAtTime(muted ? 0 : 1, now + 0.03);
	}

	// Delay (user 2026-06-14): an optional 3-tap echo on the INSTRUMENT tracks (not
	// vinyl), 1 s apart. ONE persistent network: every note routes through the
	// shared instrumentBus, which feeds the master fader DRY and a cascade of three
	// 1 s DelayNodes whose tap gains add the echoes. Nothing is created per note
	// (the v129/v140 lesson) — the taps live in the graph and keep ringing after a
	// note's source ends — so it's cheap and leak-free. The checkbox just sets the
	// tap gains (0 = off), so toggling is live and free. Built once, on the first note.
	//
	// Signal chain (user 2026-06-16): each instrument's channel level (its volume
	// slider, the random envelope, the flute-high trim) is baked into the per-note
	// gain BEFORE the bus — that's the channel fader feeding the bus. The bus mix
	// then hits the delay, and ONLY AFTER the delay does the master-volume fader
	// (masterVolNode = masterScale()) scale the whole dry+wet sum. So master volume
	// is applied post-delay, in ONE place, and now also rides the live echo tails
	// (previously it was baked per-note, upstream of the delay). It's loudness-neutral
	// at steady state — a linear scalar distributes over the summed mix — so the
	// limiter still sees the same signal at any given master setting.
	var instrumentBus = null;
	var masterVolNode = null;                        // master fader: AFTER the delay, carries masterScale() for the whole instrument mix
	var delayTaps = [];                              // the 3 tap GainNodes (wet level per tap)
	var delayNodes = [];                             // the 3 cascaded DelayNodes (for _miviam tests)
	var DELAY_TAP_S = 1;                             // 1 s (1000 ms) between taps
	var DELAY_TAP_GAINS = [0.28125, 0.16875, 0.10125]; // decaying echo level per tap (off => all 0); 3 taps; echo +50% again 2026-06-15 (was [0.1875,0.1125,0.0675]; before that [0.125,0.075,0.045]; peaks caught by the -6 dB master limiter)
	var DELAY_DEFAULT = true;                           // delay ON by default (fresh start + Reset); the
	                                                    // profile BASE stays off (Classic + empty slots) — presets opt in
	function instrumentBusTarget() {
		if (!audioCtx) { return null; }
		if (!instrumentBus) {
			var limiter = masterBusTarget();
			masterVolNode = audioCtx.createGain();
			masterVolNode.gain.value = masterScale();   // master volume, applied AFTER the delay
			masterVolNode.connect(limiter);             // master fader -> limiter -> destination
			instrumentBus = audioCtx.createGain();
			instrumentBus.connect(masterVolNode);    // DRY path (always) -> master fader
			var prev = instrumentBus;
			for (var i = 0; i < DELAY_TAP_GAINS.length; i++) {
				var d = audioCtx.createDelay(2);   // max 2 s >= each node's 1 s
				d.delayTime.value = DELAY_TAP_S;
				var g = audioCtx.createGain();
				g.gain.value = 0;             // wet level set live by applyDelay()
				prev.connect(d);
				d.connect(g);
				g.connect(masterVolNode);     // WET tap i -> master fader (echo at (i+1)*1 s)
				delayNodes.push(d);
				delayTaps.push(g);
				prev = d;                     // cascade: each next tap is 1 s further out
			}
			applyDelay();                     // honour the checkbox's current state
		}
		return instrumentBus;
	}
	function delayOn() { var el = qs("#delayCheck"); return !!(el && el.checked); }
	function applyDelay() {
		var on = delayOn();
		for (var i = 0; i < delayTaps.length; i++) {
			delayTaps[i].gain.value = on ? DELAY_TAP_GAINS[i] : 0;
		}
	}
	// Master volume rides the post-delay fader: a no-op until the bus is built (no
	// instrument sound is audible before then, so nothing to scale). Called live on
	// every master-volume change (slider + preset recall).
	function applyMasterVol() {
		if (masterVolNode) { masterVolNode.gain.value = masterScale(); }
	}


	function setupPanning() {   // name kept from the element era: routes the vinyl beds + resumes the ctx
		if (!audioCtx) { return; }
		if (vinylRouted) {
			if (audioCtx.state === "suspended") { audioCtx.resume().catch(function () {}); }
			return;
		}
		try {
			var vinylSrc = audioCtx.createMediaElementSource(vinyl);
			var vinylGain = audioCtx.createGain();
			vinylSrc.connect(vinylGain);
			vinylGain.connect(masterBusTarget());
			vinyl._gain = vinylGain;
			vinyl.volume = 1;     // the gain carries the level now; .volume would double-attenuate
		} catch (e) {
			// Keep the native element.volume path; if the element was captured but
			// not connected, wire it straight to the output so it stays audible.
			try {
				if (vinylSrc && !vinyl._gain) { vinylSrc.connect(masterBusTarget()); }
			} catch (e2) {}
		}
		setVinylVolume();     // re-apply the current slider value onto the gain
		vinylRouted = true;
		if (audioCtx.state === "suspended") { audioCtx.resume().catch(function () {}); }
	}

	// Pan position for one play of an instrument (user spec 2026-06-10): with
	// pan width 0 the sound plays exactly AT the balance position; with width
	// w > 0 each play lands at a random position anywhere from w left of the
	// balance to w right of it (uniform), clamped to the stereo field. Balance
	// 1–101 maps 51→centre, 1→full left, 101→full right; width 0–100 maps to
	// 0–the full half-field on each side.
	function panFor(volId) {
		var bEl = document.getElementById(volId.slice(0, -3) + "Balance");
		var wEl = document.getElementById(volId.slice(0, -3) + "PanWidth");
		var centre = bEl ? (parseInt(bEl.value, 10) - 51) / 50 : 0;
		var width = wEl ? parseInt(wEl.value, 10) / 100 : 0;
		var pan = centre + (Math.random() * 2 - 1) * width;
		return Math.max(-1, Math.min(1, pan));
	}

	/* ---------- sound scheduling ---------- */
	// Speed (user 2026-06-13; Mixed added 2026-06-14): NORMAL plays every note at its
	// recorded rate. SLOW plays every instrument note at half speed (playbackRate ×0.5
	// — an octave lower and twice as long), doubles the engine's tempo timers so the
	// texture stays coherent, and drops the lowest octave from selection so the
	// octave-down playback never sinks into the mud. MIXED decides PER NOTE, 50/50
	// slow-or-normal (like Direction's Mixed), at NORMAL cadence — it keeps the low
	// octave in the pool but never SLOWS a lowest-octave note (that one drop would be
	// mud). Vinyl is untouched. Persisted (key "speed", default "normal"; migrates the
	// pre-2026-06-14 boolean "slowMode" key) + saved in memory profiles. Read live;
	// toggling re-arms the players.
	var SPEED_DEFAULT = "mixed";   // user 2026-06-14: was "normal"; adopts the retired 1968 preset's value
	var SLOW_RATE = 0.5;                     // a slowed note's playbackRate × this
	var SLOW_TEMPO_MUL = 2;                  // engine timer durations × this in full Slow
	var SLOW_LOW_CUTOFF = NOTE_FLOOR + 12;   // the lowest octave (42–53): never dropped an octave by slowing
	// Bass sits an octave below the other instruments, so a SLOWED 2nd-octave bass note
	// (54–65, ×0.5 ⇒ effective pitch 42–53) sinks into the same mud a slowed lowest-octave
	// note would. Bass therefore gets an octave-higher slow floor: only bass notes ≥ 66 are
	// slow-eligible (their ×0.5 lands ≥ 54, audible). Other instruments keep SLOW_LOW_CUTOFF.
	// (user 2026-06-16 — filters out 2nd-octave-slowed-into-the-mud bass.)
	var BASS_SLOW_CUTOFF = SLOW_LOW_CUTOFF + 12;   // 66 — bass-only slow floor
	function slowFloorFor(prefix) { return prefix === "bass" ? BASS_SLOW_CUTOFF : SLOW_LOW_CUTOFF; }
	function currentSpeed() {
		var el = qs("#speedSelect");
		var v = el ? el.value : SPEED_DEFAULT;
		return (v === "normal" || v === "slow" || v === "mixed") ? v : SPEED_DEFAULT;
	}
	function slowModeOn() { return currentSpeed() === "slow"; }   // FULL slow only (kept for callers)
	// Per-note slow decision: SLOW ⇒ always; MIXED ⇒ 50/50 but never a lowest-octave
	// note (an octave below it would sink into mud); NORMAL ⇒ never.
	function noteIsSlow(note, prefix) {
		var sp = currentSpeed();
		if (sp === "slow") { return true; }   // full Slow: the pool filter (slowNoteFilter) already removed the un-slowable low notes
		if (sp === "mixed") { return note >= slowFloorFor(prefix) && Math.random() < 0.5; }
		return false;
	}
	// Could ANY note be slow at the current setting? Drives the chord-gap worst case so
	// a slowed note (×0.5 ⇒ rings ~2× longer) never bleeds past the gap into the next chord.
	function speedCanSlow() { var sp = currentSpeed(); return sp === "slow" || sp === "mixed"; }
	function tempoMul() { return currentSpeed() === "slow" ? SLOW_TEMPO_MUL : 1; }   // Mixed keeps normal cadence
	// Drop the lowest octave from a note list while FULL slow (fallback to the full list
	// so a pitch class is never left with nothing). Mixed keeps the full pool — its
	// per-note guard (noteIsSlow) handles the low octave instead.
	function slowNoteFilter(notes, prefix) {
		if (currentSpeed() !== "slow") { return notes; }
		var floor = slowFloorFor(prefix);   // 66 for bass (drops its 2nd octave too), else 54
		var hi = notes.filter(function (n) { return n >= floor; });
		return hi.length ? hi : notes;
	}

	// Playback DIRECTION (user 2026-06-14): the "Direction" dropdown plays each
	// instrument note Forward (the sample as recorded), Reversed (the sample
	// played backwards), or Mixed (each note independently 50/50 forward or
	// reversed). Read live per note; persisted ("direction") + saved in memory
	// profiles. Reversal uses a reversed COPY of the decoded buffer (Web Audio has
	// no backwards playbackRate) — see reversedBufferFor. Vinyl is a continuous
	// bed, not a note, so it is never reversed.
	var DIRECTION_DEFAULT = "mixed";   // user 2026-06-14: was "forward"; adopts the retired 1968 preset's value
	function currentDirection() {
		var sel = qs("#directionSelect");
		var v = sel ? sel.value : DIRECTION_DEFAULT;
		return (v === "forward" || v === "reversed" || v === "mixed") ? v : DIRECTION_DEFAULT;
	}
	function noteIsReversed() {
		var d = currentDirection();
		return d === "reversed" || (d === "mixed" && Math.random() < 0.5);
	}

	// Flute high-octave taming (user 2026-06-13): unless the note is slowed, a flute
	// note in the top octave (66..77, F#3..F4) plays at an extra ×0.20 (an 80% cut).
	// Slow mode is exempt entirely: its ×0.5 playbackRate already drops those notes
	// an octave, so they are not shrill highs there. Returns a multiplier (1 or
	// FLUTE_HIGH_ATTEN) folded into the per-note gain; every non-flute instrument
	// and every lower flute note is unaffected. (The earlier "unless it supports a
	// chord further down the keyboard" exception was tied to the chord BRIDGE,
	// removed 2026-06-14 — there are no bridge/chord-support notes now, so every
	// top-octave flute note is attenuated in normal speed.)
	var FLUTE_HIGH_FLOOR = NOTE_CEILING - 11;   // 66 (F#3): the flute's top octave 66..77
	var FLUTE_HIGH_ATTEN = 0.20;                // extra gain × this for a high flute note (0.20 = an 80% cut)
	function fluteHighGain(instr, note, slow) {
		if (instr.prefix !== "flute") { return 1; }
		if (slow === undefined ? slowModeOn() : slow) { return 1; }  // a slowed top note drops an octave — not shrill
		if (note < FLUTE_HIGH_FLOOR) { return 1; }                   // not the top octave
		return FLUTE_HIGH_ATTEN;
	}

	// Each chime player reschedules ITSELF after every note: wait a random gap, play
	// one note, wait again. The gap is ×SLOW_TEMPO_MUL after a SLOW note and ×1 after a
	// normal one (user 2026-06-14) — a slow note (which rings ~2× longer) earns ~2× the
	// room before the next, while normal notes stay snappy. So Slow spaces EVERY note
	// out (all slow), Normal keeps the regular cadence (none), and Mixed does it per
	// note. The 0–10 s base (×2 ⇒ 0–20 s after a slow note) matches the old
	// setInterval(5 s×mul)+offset cadence in mean and spread. The timer is tracked per
	// player so Stop / a chime-count change clears it cleanly.
	function armSoundPlayer(player, mul) {
		player.timer = setTimeout(function () {
			// If a re-arm / Stop dropped this player while its timer sat fired-but-not-yet-run,
			// do NOT reschedule — that would orphan a ghost player (clearTimeout can't cancel an
			// already-fired timer; the old setInterval was immune because clearInterval killed it
			// outright). setSoundPlayerArray marks dropped players .dead BEFORE clearing.
			if (player.dead) { return; }
			// ALWAYS re-arm, even if playSound throws (an exotic Web Audio fault): a one-shot
			// timer can't self-heal like the old setInterval, so an unguarded throw would silence
			// this voice for good. try/catch keeps the cadence alive (the player re-arms regardless).
			var slow = false;
			try { slow = playSound(); } catch (e) {}   // plays one note; true iff it drew "slow"
			armSoundPlayer(player, slow ? SLOW_TEMPO_MUL : 1);
		}, Math.floor(Math.random() * 10000 * mul));
	}

	// Ring buffer of the last notes actually started, for the _miviam debug
	// handle (headless tests assert which instruments/notes are playing).
	var NOTE_LOG_MAX = 100;
	var noteLog = [];

	// Reversed buffer for the "reversed"/"mixed" Direction. Web Audio cannot play a
	// buffer backwards via playbackRate, so a note that should be reversed plays
	// from a reversed COPY of the decoded sample. Built fresh PER NOTE and never
	// cached (user 2026-06-14): the copy lives only for that note — the source holds
	// the only reference and it is freed when the note ends — so reversal adds NO
	// resident memory, it never doubles the ~84 MB library. The flip is a ~215k-
	// sample loop, well under 1 ms, and audio renders off the main thread, so the
	// CPU/battery cost is imperceptible. Forward notes never call this. Mono PCM ⇒
	// the channel loop runs once.
	function reversedBufferFor(key) {
		var srcBuf = sampleBuffers[key];
		if (!srcBuf || !audioCtx) { return null; }
		var rev;
		try {
			rev = audioCtx.createBuffer(srcBuf.numberOfChannels, srcBuf.length, srcBuf.sampleRate);
		} catch (e) { return null; }
		var ch, i, n = srcBuf.length, input, output;
		for (ch = 0; ch < srcBuf.numberOfChannels; ch++) {
			input = srcBuf.getChannelData(ch);
			output = rev.getChannelData(ch);
			for (i = 0; i < n; i++) { output[i] = input[n - 1 - i]; }
		}
		return rev;
	}

	// Play one note NOW (both modes route through here): buffer source →
	// StereoPanner (balance + pan width, where available) → gain (the classic
	// random 0.2–0.8 envelope × instrument volume %) → the shared instrument bus
	// (delay) → master fader (main volume) → limiter → destination. Each note's
	// nodes are torn down in src.onended (v129): a
	// node that stays connected to destination is a GC root, and Firefox
	// (unlike Chrome/WebKit) never reclaims a finished-but-still-connected
	// source — so WITHOUT the explicit disconnect the per-note graph piled up
	// for the whole session (Firefox/Windows hit 28 GB after ~2 h). Old WebKit
	// without StereoPannerNode plays unpanned, exactly like the element engine.
	function playNote(instr, note, slow) {
		if (!audioCtx) { return; }
		// A source started on a non-running ctx never advances, so its onended
		// (the ONLY teardown path) never fires and the node strands connected to
		// destination — the v129 leak shape, re-openable if the OS leaves the ctx
		// suspended/interrupted mid-session while the timers keep firing. Skip the
		// note while not running and opportunistically resume so nothing piles up.
		if (audioCtx.state !== "running") { audioCtx.resume().catch(function () {}); return; }
		var s = samplerFor(note);
		if (!s) { return; }
		var key = instr.prefix + ":" + s.rootNote;
		var buf = sampleBuffers[key];
		if (!buf) { ensureInstrumentSamples(instr.prefix); return; }   // not decoded yet — kick off its load + skip this note
		// Direction: forward plays the decoded buffer as-is; reversed/mixed may swap
		// in the reversed copy (falling back to forward if it couldn't be built).
		var reversed = noteIsReversed();
		if (reversed) {
			var revBuf = reversedBufferFor(key);
			if (revBuf) { buf = revBuf; } else { reversed = false; }
		}
		var volEl = document.getElementById(instr.prefix + "Vol");
		var vol = volEl ? parseInt(volEl.value, 10) : 0;
		if (!(vol > 0)) { return; }   // position 0 = instrument off
		if (slow === undefined) { slow = noteIsSlow(note, instr.prefix); }   // playSound passes it; default for safety
		var src = audioCtx.createBufferSource();
		src.buffer = buf;
		src.playbackRate.value = s.rate * (slow ? SLOW_RATE : 1);
		var gain = audioCtx.createGain();
		// Channel level only (random envelope × instrument volume × flute trim). Master
		// volume is NOT applied here — it rides masterVolNode, AFTER the delay bus.
		gain.gain.value = (0.2 + 0.6 * Math.random()) * instrumentScale(vol) * fluteHighGain(instr, note, slow);
		var panner = null;
		if (typeof StereoPannerNode !== "undefined" && audioCtx.createStereoPanner) {
			panner = audioCtx.createStereoPanner();
			panner.pan.value = panFor(instr.prefix + "Vol");
			src.connect(panner);
			panner.connect(gain);
		} else {
			src.connect(gain);
		}
		gain.connect(instrumentBusTarget());   // shared instrument bus: dry + the 3-tap delay, then the master fader, then the limiter
		// Release the whole chainlet from the graph the instant the note ends so
		// it is no longer reachable from destination and can be collected (see
		// the note above). Natural-end onended fires once on every target while
		// the ctx is alive (created once, never closed); the null-out breaks the
		// node→handler cycle and the try/catch makes any stray late fire a no-op.
		src.onended = function () {
			src.onended = null;
			try {
				src.disconnect();
				if (panner) { panner.disconnect(); }
				gain.disconnect();
				src.buffer = null;   // release the buffer ref the instant the note ends — lets an
				                     // already-evicted (disabled-instrument) sample be GC'd promptly,
				                     // not only when the source node itself is collected. Nulling is
				                     // spec-allowed (the set-once rule blocks only a second NON-null set).
			} catch (e) {}
		};
		src.start();
		noteLog.push({ t: Math.round(performance.now()), instr: instr.prefix, note: note, rev: reversed });
		if (noteLog.length > NOTE_LOG_MAX) { noteLog.shift(); }
		// Light the matching instrument title while the settings panel is open.
		if (settingsOpen) { flashTitle(instr.prefix + "Vol"); }
	}

	// One player tick: pick the note for the current mode. Classic = the
	// selected note in a random octave (the old engine's random-clip variety,
	// recreated on the sampler — user 2026-06-10); chord = a random tone of the
	// current chord at a random octave within range (a null chord = the silent
	// gap between chords, so nothing plays). The instrument is random among the
	// enabled ones always.
	function playSound() {
		if (!(instrumentsEnabled && audioEnabled)) { return false; }
		var enabled = INSTRUMENTS.filter(function (instr) {
			var el = document.getElementById(instr.prefix + "Vol");
			return el && parseInt(el.value, 10) > 0;
		});
		if (!enabled.length) { return false; }
		var instr = enabled[Math.floor(Math.random() * enabled.length)];
		var note;
		if (currentMode() === "classic") {
			var octaves = slowNoteFilter(notesForPc(NOTE_PCS[currentClassicNote()]), instr.prefix);
			note = octaves[Math.floor(Math.random() * octaves.length)];
		} else {
			if (currentChordPc === null) { return false; }   // no chord (incl. the silent gap) — play nothing
			var ivs = currentChordFormula();
			var pc = (currentChordPc + ivs[Math.floor(Math.random() * ivs.length)]) % 12;
			var octaves = slowNoteFilter(notesForPc(pc), instr.prefix);
			note = octaves[Math.floor(Math.random() * octaves.length)];
		}
		var slow = noteIsSlow(note, instr.prefix);   // decide ONCE; drives playbackRate AND the next note's gap
		playNote(instr, note, slow);
		return slow;
	}

	function setSoundPlayerArray(totalSounds) {
		var i;
		for (i = 0; i < soundPlayerArray.length; i++) {
			soundPlayerArray[i].dead = true;            // mark BEFORE clearing so an already-fired-but-
			clearTimeout(soundPlayerArray[i].timer);    // not-yet-run callback bails instead of orphaning
		}
		soundPlayerArray = [];
		for (i = 0; i < totalSounds; i++) {
			var player = { timer: null, dead: false };
			soundPlayerArray.push(player);
			armSoundPlayer(player, 1);   // first note of the session: a normal-length wait
		}
	}

	/* ---------- sleep timer ---------- */
	function updateSleepIndicator() {
		qs("#sleepButton").value =
			"Sleep (" + Math.ceil((sleepEndTime.getTime() - Date.now()) / 60000) + ")";
	}

	// Sleep mode = play mode + a 60-minute countdown on the Sleep button's
	// label; expiry behaves exactly like pressing Stop. Sleep is DISABLED
	// while anything plays (the button-state spec, user 2026-06-11), so this
	// only ever fires from the stopped state — the guard is belt-and-braces.
	function startSleepTimer() {
		if (audioEnabled) { return; }   // never start over a running engine
		clearInterval(sleepInterval);
		startAudio();                   // disables Start + Sleep, enables Stop
		sleepEndTime = new Date(Date.now() + 3600000);
		updateSleepIndicator();
		sleepInterval = setInterval(function () {
			updateSleepIndicator();
			if (Date.now() > sleepEndTime.getTime()) {
				stopAudio();            // clears this interval + resets all buttons
			}
		}, 5000);
	}

	/* ---------- transport ---------- */
	function stopAudio() {
		clearInterval(sleepInterval);
		qs("#sleepButton").value = "Sleep";
		qs("#stopButton").disabled = true;
		qs("#startButton").disabled = false;
		qs("#sleepButton").disabled = false;
		audioEnabled = false;
		setAppMute(true);              // master mute: silence the whole mix at once (cuts the ringing note/echo tails)
		setSoundPlayerArray(0);
		clearChordTimers();            // a pending chord-state end or gap end must not fire after Stop
		currentChordPc = null;         // next Start draws a fresh chord
		vinyl.pause();
		if (ghost) { ghost.pause(); }   // release the audio session (Control Center / audio focus)
		setPlaybackState("paused");
		// (Notes in flight are ≤ ~5.2 s and finish on their own — matching the
		// original engine, which only paused the vinyl loop here.)
	}

	// Button-state machine (user 2026-06-11): stopped = Start + Sleep
	// enabled, Stop disabled; playing/sleeping = ONLY Stop enabled. The
	// re-entry guard is the hard rule behind it — a second engine instance
	// must NEVER launch on top of a running one (the old Sleep-while-playing
	// bug). Everything that stops playback funnels through stopAudio, which
	// restores the stopped state.
	function startAudio() {
		if (audioEnabled) { return; }   // never launch a second engine
		qs("#startButton").disabled = true;
		qs("#sleepButton").disabled = true;
		qs("#stopButton").disabled = false;
		audioEnabled = true;
		// Fresh audio-focus-yield budget for this play session (see the keep-alive
		// pause handlers): a user Start should get a clean chance to hold focus.
		if (ghost) { ghost._pauseHist = []; }
		vinyl._pauseHist = [];
		setupPanning();   // user gesture: route the vinyl bed / resume the ctx
		setAppMute(false);   // running: unmute the master output
		if (currentMode() === "chord") {
			// Always a fresh start (the guard above bars re-entry, and Stop
			// cleared any chord timers) — begin a new progression.
			startChordEngine();
		} else {
			clearChordTimers();
		}
		try { playSound(); } catch (e) {}   // immediate first note; a throw must NOT abort the rest of startAudio
		setSoundPlayerArray(parseInt(qs("#totalSoundsSelect").value, 10));
		setVinylVolume();   // start the bed if audible; pause it if silent
		playGhost();        // silent keep-alive bed (plain element, never routed) — holds the media session
		setPlaybackState("playing");
	}

	/* ---------- volume / balance / pan-width controls ---------- */
	function balanceLabel(value) {
		// 1–101 → "L50 … L1, 0, R1 … R50" (centre displays as 0 — user 2026-06-10)
		var n = parseInt(value, 10) - 51;
		return (n === 0) ? "0" : ((n < 0 ? "L" : "R") + Math.abs(n));
	}

	function updateVolLabel(slider) {
		var label = document.getElementById(slider.id + "Val");
		if (label) {
			label.textContent = slider.classList.contains("instrumentBalance")
				? balanceLabel(slider.value)
				: slider.value;
		}
		updateSummary(slider.id);
		refreshDial(slider);   // keep the rotary dial's indicator in sync (no-op before setupDials)
	}

	// Settings-box summary header, e.g. "VOL: 100   BAL: L10   PAN: 0" — the
	// gaps are three non-breaking spaces (user spec 2026-06-10); the vinyl
	// and main-volume boxes have only "VOL: n". Called from updateVolLabel so
	// every path that refreshes a label (input, restore, reset, migration)
	// refreshes the summary too. A slider id maps to its box's summary span
	// (celloVol / celloBalance / celloPanWidth → #celloSummary, vinylVol →
	// #vinylSummary, masterVol → #masterSummary).
	var NBSP3 = "\u00A0\u00A0\u00A0";

	// Fit-to-width summaries (v78, user 2026-06-11 \u2014 "summary text is really
	// small, like half the width of the screen"): the static v59 font ladder
	// sized each breakpoint TIER for its narrowest possible screen, leaving
	// big slack on wider phones (11px on a 412px device keyed to a 361px
	// floor). Instead, size each summary LIVE to the largest whole px that
	// fits ITS text in ITS box \u2014 the user's "largest that fits" rule applied
	// continuously. Capped at the body text size (so desktop, where the
	// summary already fits at body size, is unchanged); floored at 10px; the
	// CSS ladder remains as the pre-fit fallback. Wrapping is impossible by
	// construction. Measured with canvas in the span's own font (Verdana is
	// the widest of the stack \u2014 fallback fonts only gain margin).
	var summaryMeasureCtx = null;

	function fitSummary(span) {
		var available = span.clientWidth;
		if (!(available > 0)) { return; }   // panel hidden \u2014 refit when it opens
		if (!summaryMeasureCtx) {
			try { summaryMeasureCtx = document.createElement("canvas").getContext("2d"); } catch (e) {}
			if (!summaryMeasureCtx) { return; }   // no canvas: keep the CSS ladder size
		}
		var style = getComputedStyle(span);
		summaryMeasureCtx.font = style.fontWeight + " 100px " + style.fontFamily;
		var w100 = summaryMeasureCtx.measureText(span.textContent).width;
		if (!(w100 > 0)) { return; }
		var cap = parseFloat(getComputedStyle(document.body).fontSize) || 18;
		var size = Math.floor(((available - 2) * 100) / w100);   // \u22122px safety
		span.style.fontSize = Math.max(10, Math.min(cap, size)) + "px";
	}

	function refitAllSummaries() {
		qsa(".settingsSummary").forEach(fitSummary);
	}

	function updateSummary(sliderId) {
		var prefix = null;
		if (/Vol$/.test(sliderId)) { prefix = sliderId.slice(0, -3); }
		else if (/Balance$/.test(sliderId)) { prefix = sliderId.slice(0, -7); }
		else if (/PanWidth$/.test(sliderId)) { prefix = sliderId.slice(0, -8); }
		var span = prefix ? document.getElementById(prefix + "Summary") : null;
		if (!span) { return; }
		if (prefix === "vinyl" || prefix === "master") {
			span.textContent = "VOL: " + document.getElementById(prefix + "Vol").value;
		} else {
			span.textContent =
				"VOL: " + document.getElementById(prefix + "Vol").value + NBSP3 +
				"BAL: " + balanceLabel(document.getElementById(prefix + "Balance").value) + NBSP3 +
				"WID: " + document.getElementById(prefix + "PanWidth").value;
		}
		fitSummary(span);
	}

	function buildSoundArray() {
		// (Name kept from the element era.) Persists + relabels the volume
		// sliders and recomputes whether ANY instrument is enabled — the note
		// pickers read the live slider values at each play.
		var any = false;
		qsa(".instrumentVol").forEach(function (slider) {
			var vol = parseInt(slider.value, 10);   // 0–100 (0 = off, 1–100 = volume %)
			lsSet(slider.id, vol);
			updateVolLabel(slider);
			if (vol > 0) { any = true; }
		});
		instrumentsEnabled = any;
		scheduleReconcile();   // lazy-decode newly-active instruments / evict the rest (debounced)
	}

	/* ---------- Rotary dials (user 2026-06-16) ---------- */
	// The instrument (Volume/Balance/Width), vinyl (Volume) and main-volume sliders are
	// presented as rotary dials. Each control's <input type=range> stays in the DOM as the value store
	// and event source — so ALL existing logic (restoreState, gatherPatch, buildSoundArray,
	// panFor, presets, the #patch= URL) is untouched; the dial is a visual +
	// pointer layer over it. setupDials() runs once at load: it groups each drawer's
	// slider(s) into a side-by-side .dialRow (the inputs hidden, the numeric score moved
	// under each dial) and wires drag / wheel / arrow-keys. refreshDial(), called from
	// updateVolLabel, keeps the indicator in sync with every programmatic value change.
	var DIAL_SWEEP_DEG = 270;          // total angular travel (min..max), centred on 12 o'clock
	var DIAL_DRAG_PX = 180;            // vertical drag (px) that sweeps the full min..max
	var DIAL_SVG = '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
		'<circle class="dialFace" cx="50" cy="50" r="45"></circle>' +
		'<line class="dialIndicator" x1="50" y1="30" x2="50" y2="12" transform="rotate(0 50 50)"></line>' +
		'</svg>';

	function dialLabelFor(input) {
		if (input.classList.contains("instrumentBalance")) { return "Balance"; }
		if (input.classList.contains("instrumentPanWidth")) { return "Width"; }
		return "Volume";   // instrumentVol or vinylVol
	}
	function dialFraction(input) {
		var min = parseFloat(input.min), max = parseFloat(input.max), v = parseFloat(input.value);
		if (!(max > min)) { return 0; }
		var f = (v - min) / (max - min);
		return f < 0 ? 0 : (f > 1 ? 1 : f);
	}
	function renderDial(dial) {
		var input = document.getElementById(dial.getAttribute("data-for"));
		if (!input) { return; }
		var angle = -DIAL_SWEEP_DEG / 2 + dialFraction(input) * DIAL_SWEEP_DEG;   // -135°..+135°, 0°=up
		var ind = dial.querySelector(".dialIndicator");
		if (ind) { ind.setAttribute("transform", "rotate(" + angle.toFixed(1) + " 50 50)"); }
		dial.setAttribute("aria-valuenow", input.value);
		if (input.classList.contains("instrumentBalance")) {
			dial.setAttribute("aria-valuetext", balanceLabel(input.value));
		}
	}
	function refreshDial(input) {   // re-sync a dial after a programmatic value change
		var dial = input && document.querySelector('.dial[data-for="' + input.id + '"]');
		if (dial) { renderDial(dial); }
	}
	function dialCommit(input, raw, fireChange) {
		var min = parseFloat(input.min), max = parseFloat(input.max), step = parseFloat(input.step) || 1;
		var v = Math.round(raw / step) * step;
		if (v < min) { v = min; } else if (v > max) { v = max; }
		if (step >= 1) { v = Math.round(v); }
		if (String(v) !== String(input.value)) {
			input.value = v;
			input.dispatchEvent(new Event("input", { bubbles: true }));   // live: drives buildSoundArray/setVinylVolume/syncUrl + refreshDial
		}
		if (fireChange) { input.dispatchEvent(new Event("change", { bubbles: true })); }
	}
	function initDial(dial) {
		var input = document.getElementById(dial.getAttribute("data-for"));
		if (!input) { return; }
		dial.innerHTML = DIAL_SVG;
		dial.setAttribute("role", "slider");
		dial.setAttribute("tabindex", "0");
		dial.setAttribute("aria-label", dialLabelFor(input));
		dial.setAttribute("aria-valuemin", input.min);
		dial.setAttribute("aria-valuemax", input.max);
		renderDial(dial);

		// Drag is VERTICAL only — drag UP to increase, DOWN to decrease (NOT circular;
		// the user only moves up/down, the indicator line just rotates to show the value).
		// The move/up listeners live on the WINDOW for the whole gesture so tracking never
		// drops when the finger leaves the small dial; they detach on release.
		var startY = 0, startV = 0, moved = false, activeId = null;
		function dialMove(e) {
			if (activeId === null || e.pointerId !== activeId) { return; }
			var min = parseFloat(input.min), max = parseFloat(input.max);
			var f = (startV - min) / (max - min) + (startY - e.clientY) / DIAL_DRAG_PX;   // only clientY matters: up = increase
			if (f < 0) { f = 0; } else if (f > 1) { f = 1; }
			moved = true;
			dialCommit(input, min + f * (max - min), false);
			e.preventDefault();
		}
		function dialUp(e) {
			if (activeId === null || (e.pointerId != null && e.pointerId !== activeId)) { return; }
			window.removeEventListener("pointermove", dialMove);
			window.removeEventListener("pointerup", dialUp);
			window.removeEventListener("pointercancel", dialUp);
			activeId = null;
			if (moved) { input.dispatchEvent(new Event("change", { bubbles: true })); }   // commit, like releasing a native slider
		}
		dial.addEventListener("pointerdown", function (e) {
			activeId = e.pointerId; moved = false; startY = e.clientY; startV = parseFloat(input.value);
			window.addEventListener("pointermove", dialMove);
			window.addEventListener("pointerup", dialUp);
			window.addEventListener("pointercancel", dialUp);
			e.preventDefault();
		});
		dial.addEventListener("wheel", function (e) {
			e.preventDefault();
			var step = parseFloat(input.step) || 1;
			dialCommit(input, parseFloat(input.value) + (e.deltaY < 0 ? step : -step), true);
		}, { passive: false });
		dial.addEventListener("keydown", function (e) {
			var step = parseFloat(input.step) || 1, d = 0;
			if (e.key === "ArrowUp" || e.key === "ArrowRight") { d = step; }
			else if (e.key === "ArrowDown" || e.key === "ArrowLeft") { d = -step; }
			else if (e.key === "Home") { dialCommit(input, parseFloat(input.min), true); e.preventDefault(); return; }
			else if (e.key === "End") { dialCommit(input, parseFloat(input.max), true); e.preventDefault(); return; }
			else { return; }
			dialCommit(input, parseFloat(input.value) + d, true);
			e.preventDefault();
		});
	}
	function setupDials() {
		// In each instrument / vinyl / main-volume drawer, group the slider(s) into one row.
		qsa(".settingsBoxDrawer").forEach(function (drawer) {
			var inputs = Array.prototype.slice.call(
				drawer.querySelectorAll(".instrumentVol, .instrumentBalance, .instrumentPanWidth, .vinylVol"));
			if (!inputs.length) { return; }
			var row = document.createElement("div");
			row.className = "dialRow";
			drawer.insertBefore(row, inputs[0].previousElementSibling || inputs[0]);
			inputs.forEach(function (input) {
				var labelDiv = input.previousElementSibling;   // the "<Name>: <span>" subLabel row
				var cell = document.createElement("div");
				cell.className = "dialCell";
				var lab = document.createElement("div");
				lab.className = "dialLabel";
				lab.textContent = dialLabelFor(input);
				var dial = document.createElement("div");
				dial.className = "dial";
				dial.setAttribute("data-for", input.id);
				var val = document.getElementById(input.id + "Val");
				cell.appendChild(lab);
				cell.appendChild(dial);
				if (val) { cell.appendChild(val); }   // numeric score under the dial
				cell.appendChild(input);              // hidden source-of-truth (CSS display:none)
				row.appendChild(cell);
				if (labelDiv && labelDiv.classList && labelDiv.classList.contains("subLabel")) {
					labelDiv.parentNode.removeChild(labelDiv);
				}
			});
		});
		qsa(".dial").forEach(initDial);
	}

	// "Would the bed actually be heard?" — false when the slider is 0 or the master
	// is 0 (the effective gain is then 0). When false the bed is PAUSED rather than
	// run silently (user 2026-06-14): the unrouted silent ghost already holds the
	// media session, so there's no point spinning the noise stream's DSP for nothing.
	// The pause handlers + focus-yield below also gate on this, so an intentional
	// silence-pause is never auto-resumed or miscounted.
	function vinylAudible() {
		var el = qs("#vinylVol");
		var v = el ? parseInt(el.value, 10) : 0;
		return vinylScale(v) * masterScale() > 0;   // 0 when slider 0 OR master 0
	}

	function setVinylVolume() {
		var slider = qs("#vinylVol");
		var v = parseInt(slider.value, 10);   // 0–100 (0 = silent)
		// The bed's level: slider scale × master.
		var vol = vinylScale(v) * masterScale();   // 1–100 -> 1%–50%
		if (vinyl._gain) {
			vinyl._gain.gain.value = vol;   // routed: linear Web Audio gain, same loudness on every browser
		} else {
			vinyl.volume = vol;             // not (yet) routed: native element volume
		}
		updateVolLabel(slider);
		// Play the bed only while it'd be heard; otherwise PAUSE it (the ghost holds
		// the media session).
		if (audioEnabled && vinylAudible()) {
			vinyl.play().catch(function () {});
		} else {
			vinyl.pause();
		}
	}

	// Ghost keep-alive: a silent FILE played unmuted at full volume on a plain,
	// unrouted element. Its volume/muted are never touched — iOS ignores
	// element.volume (hardware-controlled) and treats muted media as
	// non-audible, either of which would defeat the keep-alive. The file being
	// silence is what keeps it inaudible on every platform.
	function playGhost() {
		if (ghost && audioEnabled) {
			ghost.play().catch(function () {});
		}
	}

	/* ---------- settings persistence ---------- */
	function restoreState() {
		migrateScaleV2();        // saved 0–20 mixes → the percent scales, once
		migrateVinylScaleV3();   // vinyl percent (0–33) → the 101-position scale, once
		loadUrlPatchIntoStorage();   // a shared #patch= patch overrides saved settings (already new-scale)

		qsa(".instrumentVol").forEach(function (slider) {
			var c = lsGet(slider.id);
			slider.value = (c !== null) ? c : (INSTRUMENT_DEFAULTS[slider.id] || "100");
			updateVolLabel(slider);
		});
		qsa(".instrumentBalance").forEach(function (slider) {
			var c = lsGet(slider.id);
			slider.value = (c !== null) ? c : BALANCE_DEFAULT;
			updateVolLabel(slider);
		});
		qsa(".instrumentPanWidth").forEach(function (slider) {
			var c = lsGet(slider.id);
			slider.value = (c !== null) ? c : (PAN_WIDTH_DEFAULTS[slider.id] || "0");
			updateVolLabel(slider);
		});

		var vv = lsGet("vinylVol");
		qs("#vinylVol").value = (vv !== null) ? vv : VINYL_DEFAULT;
		updateVolLabel(qs("#vinylVol"));

		var mv = lsGet("masterVol");
		qs("#masterVol").value = (mv !== null) ? mv : MASTER_DEFAULT;
		updateVolLabel(qs("#masterVol"));

		var ts = lsGet("totalSoundsSelect");
		qs("#totalSoundsSelect").value = (ts !== null) ? ts : TOTAL_SOUNDS_DEFAULT;
		// A shared #patch= patch can carry an out-of-range chimes value; if it doesn't
		// match an <option> (selectedIndex -1) fall back to the default so the engine
		// never schedules NaN players (mirrors the speed select + applyMemoryProfile).
		if (qs("#totalSoundsSelect").selectedIndex === -1) { qs("#totalSoundsSelect").value = TOTAL_SOUNDS_DEFAULT; }

		// Playback mode (v72): persisted like every other setting; anything
		// other than a saved "classic" means the default, Chord.
		qs("#modeSelect").value = (lsGet("mode") === "classic") ? "classic" : MODE_DEFAULT;

		// Chord quality (v73): persisted; unknown/unsaved values fall back to
		// the default so a stale key can never select nothing.
		var ct = lsGet("chordTone");
		qs("#chordToneSelect").value = isValidChordTone(ct) ? ct : CHORD_TONE_DEFAULT;

		// Classic note (v74): same treatment.
		var cn = lsGet("classicNote");
		qs("#classicNoteSelect").value = NOTE_PCS.hasOwnProperty(cn) ? cn : CLASSIC_NOTE_DEFAULT;

		// Speed (v137; 3-state 2026-06-14): persisted "speed" = normal/slow/mixed,
		// migrating the pre-2026-06-14 boolean "slowMode" key (true => slow). Invalid
		// or absent => default normal; if a stray value leaves the select on nothing,
		// re-default.
		var spd = lsGet("speed");
		if (spd !== "slow" && spd !== "mixed" && spd !== "normal") {
			spd = (lsGet("slowMode") === "true") ? "slow" : SPEED_DEFAULT;
		}
		qs("#speedSelect").value = spd;
		if (qs("#speedSelect").selectedIndex === -1) { qs("#speedSelect").value = SPEED_DEFAULT; }

		// Direction (2026-06-14): persisted "direction" key; unknown ⇒ Forward.
		var dir = lsGet("direction");
		qs("#directionSelect").value = (dir === "forward" || dir === "reversed" || dir === "mixed") ? dir : DIRECTION_DEFAULT;

		// Delay (2026-06-14): persisted boolean "delay" — DEFAULT ON (DELAY_DEFAULT) when the
		// key is absent (a fresh visit); a stored value wins. autocomplete=off on the box
		// stops Firefox restoring a stale checked state across reload.
		var dly = lsGet("delay");
		qs("#delayCheck").checked = (dly === null) ? DELAY_DEFAULT : (dly === "true");
		applyDelay();

		updateChordToneVisibility();
	}

	/* ---------- Memory: five permanent presets + four profile slots ---------- */
	// (user 2026-06-12) A profile holds the WHOLE mix except the main volume
	// (excluded by default — recalling a mix shouldn't change your output level;
	// the "Default" preset and a shared URL patch are the exceptions, carrying
	// masterVol so they reproduce the full state): every instrument's volume /
	// balance / width (muted = volume 0), the vinyl volume, the chime frequency,
	// the mode and both mode fields (chord tone + classic note — both stored so
	// either mode recalls intact). The PRESET buttons (Default / Space Opera /
	// Classic / Celestial / Chamber / Drifter — their names are their button labels) recall
	// factory mixes 9/1/2/7/8/10 directly: no Store, no title, nothing to clear.
	// "Default" (9) is the app's fresh-load defaults and replaced the old "Reset
	// to default" button (user 2026-06-14). The SLOTS (3..6) each have Store N /
	// Recall N; Store asks for confirmation through the system dialog first. Slots
	// persist as JSON under memory3..memory6; an empty slot falls back to the app
	// defaults, so Recall is always available.
	var MEMORY_SLOTS = [3, 4, 5, 6];

	function memorySliderIds() {
		var ids = [];
		INSTRUMENTS.forEach(function (instr) {
			ids.push(instr.prefix + "Vol", instr.prefix + "Balance", instr.prefix + "PanWidth");
		});
		ids.push("vinylVol");
		return ids;
	}


	// Factory contents: 1/2/7/8/9/10 are the permanent presets' mixes (Space Opera /
	// Classic / Celestial / Chamber / Default / Drifter); slots 3..6 fall through to the base
	// (empty-state fallback).
	// Built from the same constants as Reset so "default" can never drift
	// from the app's own. The user's values are display-scale — a Balance
	// of 0 is slider 51 (BALANCE_DEFAULT), which the base already applies
	// to every instrument, named or muted.
	function defaultMemoryProfile(n) {
		var p = {};
		INSTRUMENTS.forEach(function (instr) {
			p[instr.prefix + "Vol"] = INSTRUMENT_DEFAULTS[instr.prefix + "Vol"] || "100";
			p[instr.prefix + "Balance"] = BALANCE_DEFAULT;
			p[instr.prefix + "PanWidth"] = PAN_WIDTH_DEFAULTS[instr.prefix + "PanWidth"] || "0";
		});
		p.vinylVol = VINYL_DEFAULT;
		p.totalSoundsSelect = TOTAL_SOUNDS_DEFAULT;
		p.mode = MODE_DEFAULT;
		p.chordTone = CHORD_TONE_DEFAULT;
		p.classicNote = CLASSIC_NOTE_DEFAULT;
		p.speed = SPEED_DEFAULT;
		p.direction = DIRECTION_DEFAULT;
		p.delay = false;     // base/Classic/empty-slots OFF (the LIVE default is ON — see DELAY_DEFAULT; presets opt in)
		if (n === 1) {
			// "Space Opera": the choir alone, loud and wide; chimes at 3.
			INSTRUMENTS.forEach(function (instr) { p[instr.prefix + "Vol"] = "0"; });
			p.choirVol = "100";
			p.choirPanWidth = "28";
			p.totalSoundsSelect = "3";
			p.vinylVol = "20";
			p.delay = true;     // user 2026-06-14: Space Opera recalls with Delay on
		} else if (n === 2) {
			// "Classic": classic mode on the note D; the core instruments at
			// their usual levels. The re-added Bass (2026-06-13) sits centred
			// and un-widened; the rest scatter at width 25. Chimes 4, Speed
			// Normal, Direction Forward, Delay off (user 2026-06-15).
			INSTRUMENTS.forEach(function (instr) { p[instr.prefix + "Vol"] = "0"; });
			p.bassVol = "100";   p.bassPanWidth = "0";
			p.fluteVol = "50";   p.flutePanWidth = "25";
			p.rhodesVol = "100"; p.rhodesPanWidth = "25";
			p.vibesVol = "80";   p.vibesPanWidth = "25";
			p.mode = "classic";
			p.classicNote = "D";
			p.vinylVol = "20";
			p.totalSoundsSelect = "4";
			p.speed = "normal";
			p.direction = "forward";
			p.delay = false;
		} else if (n === 7) {
			// "Celestial" (user 2026-06-14): celeste alone, chord mode (Major). Vol 75,
			// chimes 5, balance centred (display 0), width 50, Delay on, Forward, Normal.
			INSTRUMENTS.forEach(function (instr) { p[instr.prefix + "Vol"] = "0"; });
			p.celesteVol = "75";
			p.celesteBalance = BALANCE_DEFAULT;   // display 0 (centre)
			p.celestePanWidth = "50";
			p.mode = "chord";
			p.chordTone = "MAJOR";
			p.totalSoundsSelect = "5";
			p.vinylVol = "20";
			p.delay = true;
			p.direction = "forward";
			p.speed = "normal";
		} else if (n === 8) {
			// "Chamber" (user 2026-06-14): cello + flute only, chord mode (Random), no
			// Delay. Cello 100, flute 70, balance centred (display 0), width 20, chimes 4,
			// Forward, Normal.
			INSTRUMENTS.forEach(function (instr) { p[instr.prefix + "Vol"] = "0"; });
			p.celloVol = "100";  p.celloBalance = BALANCE_DEFAULT;  p.celloPanWidth = "20";
			p.fluteVol = "70";   p.fluteBalance = BALANCE_DEFAULT;  p.flutePanWidth = "20";
			p.vinylVol = "20";
			p.mode = "chord";
			p.chordTone = "RANDOM";
			p.totalSoundsSelect = "4";
			p.delay = false;
			p.direction = "forward";
			p.speed = "normal";
		} else if (n === 9) {
			// "Default" (user 2026-06-14): the app's fresh-load defaults exactly, so this
			// preset replaces the old "Reset to default" button. The base already mirrors
			// every default constant; only Delay differs (LIVE default is ON via
			// DELAY_DEFAULT, the profile base is OFF) so re-assert it, and — unlike other
			// presets — also carry the default main volume so Default is a FULL reset.
			p.delay = DELAY_DEFAULT;
			p.masterVol = MASTER_DEFAULT;
		} else if (n === 10) {
			// "Drifter" (user 2026-06-16): the default mix, but Forward direction and
			// no Delay. A distinct mood preset now (no longer a copy of Default), so it
			// is master-agnostic like the other presets — only Default (n===9) carries
			// masterVol, for the full reset. (Base already sets delay=false; explicit here.)
			p.direction = "forward";
			p.delay = false;
			p.vinylVol = "20";
		}
		// Slots (3..6): the base — every value at the app's own default.
		return p;
	}

	function getMemoryProfile(n) {
		var raw = lsGet("memory" + n);
		if (raw) {
			try { return JSON.parse(raw); } catch (e) {}
		}
		return defaultMemoryProfile(n);
	}

	// A "patch" is the full option state. gatherPatch reads it from the live controls:
	// the same fields a memory profile stores (every instrument's volume/balance/width,
	// vinyl, chimes, mode, chord tone, classic note, speed, direction, delay) and —
	// when includeMaster is true (the shareable URL patch only) — the main volume.
	function gatherPatch(includeMaster) {
		var p = {};
		memorySliderIds().forEach(function (id) {
			var el = document.getElementById(id);
			if (el) { p[id] = el.value; }
		});
		p.totalSoundsSelect = qs("#totalSoundsSelect").value;
		p.mode = qs("#modeSelect").value;
		p.chordTone = qs("#chordToneSelect").value;
		p.classicNote = qs("#classicNoteSelect").value;
		p.speed = qs("#speedSelect").value;
		p.direction = qs("#directionSelect").value;
		p.delay = qs("#delayCheck").checked;
		if (includeMaster) { p.masterVol = qs("#masterVol").value; }
		return p;
	}

	function storeMemory(n) {
		if (!window.confirm('Overwrite "' + getMemoryTitle(n) + '" with the current settings?')) { return; }
		// Stored slots stay master-agnostic (recalling a mix shouldn't change output level).
		lsSet("memory" + n, JSON.stringify(gatherPatch(false)));
	}

	/* ---------- Shareable patch in the URL (user 2026-06-14) ---------- */
	// The full current patch (gatherPatch incl. main volume) is mirrored into the URL
	// hash (#patch=<base64url JSON>) on every change, so the URL always reflects the live
	// state and a patch can be shared just by copying the link. On load a #patch= patch
	// overrides saved settings (folded into localStorage so restoreState applies +
	// persists it so it plays as shared). Hash (not query) keeps it
	// client-side — never sent to the server or cached by the service worker.
	var URL_PATCH_PARAM = "patch";   // the URL hash key: #patch=<base64url JSON> (renamed from "p" 2026-06-16)
	var urlSyncTimer = null;
	function encodePatch(p) {
		// the patch JSON is ASCII (keys + number/word/boolean values) so btoa is safe
		return btoa(JSON.stringify(p)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	}
	function decodePatch(str) {
		try {
			var obj = JSON.parse(atob(str.replace(/-/g, "+").replace(/_/g, "/")));
			return (obj && typeof obj === "object") ? obj : null;
		} catch (e) { return null; }
	}
	function patchFromUrl() {
		var m = (location.hash || "").match(/[#&]patch=([^&]+)/);
		return m ? decodePatch(m[1]) : null;
	}
	function syncUrl() {
		try {
			var enc = encodePatch(gatherPatch(true));
			history.replaceState(null, "", location.pathname + location.search + "#" + URL_PATCH_PARAM + "=" + enc);
		} catch (e) {}
	}
	function syncUrlSoon() {
		if (urlSyncTimer) { clearTimeout(urlSyncTimer); }
		urlSyncTimer = setTimeout(syncUrl, 200);   // coalesce slider drags
	}
	// On load: fold a #patch= patch into localStorage (only KNOWN fields; restoreState then
	// validates each) so the shared patch becomes the applied + persisted state.
	function loadUrlPatchIntoStorage() {
		var patch = patchFromUrl();
		if (!patch) { return; }
		var known = gatherPatch(true);   // its KEYS are the valid patch fields
		Object.keys(known).forEach(function (k) {
			if (!Object.prototype.hasOwnProperty.call(patch, k)) { return; }
			var v = patch[k];
			if (typeof v === "boolean") { v = v ? "true" : "false"; }
			lsSet(k, String(v));
		});
	}

	// Applies a profile object to the app — shared by the slot Recalls and
	// the preset buttons (which feed it a factory mix directly).
	function applyMemoryProfile(profile) {
		memorySliderIds().forEach(function (id) {
			var el = document.getElementById(id);
			if (el && Object.prototype.hasOwnProperty.call(profile, id)) {
				el.value = profile[id];     // a range input clamps stray values itself
				lsSet(id, el.value);
				updateVolLabel(el);
			}
		});
		// Main volume is normally NOT part of a profile (recalling a mix shouldn't
		// change your output level). The "Default" preset and a shared URL patch DO
		// carry it, so apply masterVol only when the profile actually defines it
		// (user 2026-06-14).
		if (Object.prototype.hasOwnProperty.call(profile, "masterVol")) {
			var mvEl = qs("#masterVol");
			mvEl.value = profile.masterVol;
			lsSet("masterVol", mvEl.value);
			updateVolLabel(mvEl);
		}
		// Selects, validated exactly like restoreState so a stale stored
		// value can never select nothing. hasOwnProperty guards keep a
		// pre-v116 sliders-only profile from touching them at all.
		if (Object.prototype.hasOwnProperty.call(profile, "mode")) {
			qs("#modeSelect").value = (profile.mode === "classic") ? "classic" : MODE_DEFAULT;
			lsSet("mode", qs("#modeSelect").value);
		}
		if (Object.prototype.hasOwnProperty.call(profile, "chordTone")) {
			qs("#chordToneSelect").value = isValidChordTone(profile.chordTone) ? profile.chordTone : CHORD_TONE_DEFAULT;
			lsSet("chordTone", qs("#chordToneSelect").value);
		}
		if (Object.prototype.hasOwnProperty.call(profile, "classicNote")) {
			qs("#classicNoteSelect").value = NOTE_PCS.hasOwnProperty(profile.classicNote) ? profile.classicNote : CLASSIC_NOTE_DEFAULT;
			lsSet("classicNote", qs("#classicNoteSelect").value);
		}
		if (Object.prototype.hasOwnProperty.call(profile, "totalSoundsSelect")) {
			var ts = qs("#totalSoundsSelect");
			ts.value = profile.totalSoundsSelect;
			if (ts.selectedIndex === -1) { ts.value = TOTAL_SOUNDS_DEFAULT; }
			lsSet("totalSoundsSelect", ts.value);
		}
		if (Object.prototype.hasOwnProperty.call(profile, "speed")) {
			var psp = profile.speed;
			qs("#speedSelect").value = (psp === "normal" || psp === "slow" || psp === "mixed") ? psp : SPEED_DEFAULT;
			lsSet("speed", qs("#speedSelect").value);
		} else if (Object.prototype.hasOwnProperty.call(profile, "slowMode")) {
			qs("#speedSelect").value = profile.slowMode ? "slow" : "normal";   // migrate a pre-2026-06-14 profile
			lsSet("speed", qs("#speedSelect").value);
		}
		if (Object.prototype.hasOwnProperty.call(profile, "direction")) {
			var pd = profile.direction;
			qs("#directionSelect").value = (pd === "forward" || pd === "reversed" || pd === "mixed") ? pd : DIRECTION_DEFAULT;
			lsSet("direction", qs("#directionSelect").value);
		}
		if (Object.prototype.hasOwnProperty.call(profile, "delay")) {
			qs("#delayCheck").checked = !!profile.delay;
			lsSet("delay", profile.delay ? "true" : "false");
			applyDelay();
		}
		buildSoundArray();   // instrumentsEnabled + persists vols
		setVinylVolume();    // the bed re-scales live if playing
		applyMasterVol();    // a profile carrying masterVol (Default / URL patch) re-scales the instrument mix live
		updateChordToneVisibility();
		// A mid-play recall is LIVE: re-arm the interval players at the recalled
		// chime count (NOT via startAudio — non-reentrant) and restart the chord
		// machinery the way a mode change does. A recall/preset while STOPPED
		// instead STARTS playback with the recalled mix (user 2026-06-14).
		if (audioEnabled) {     // not gated on instrumentsEnabled (v139): re-arm at the recalled tempo even if muted
			setSoundPlayerArray(parseInt(qs("#totalSoundsSelect").value, 10));
		}
		if (audioEnabled) {
			// Live recall mid-chord: re-start through a leading gap (NOT an
			// immediate new chord) so the outgoing chord + echoes don't overlap
			// the recalled one. In classic mode just clear the timers.
			if (currentMode() === "chord") { restartChordGap(); }
			else { clearChordTimers(); currentChordPc = null; }
		} else {
			clearChordTimers();
			currentChordPc = null;
			startAudio();   // reads the controls we just applied; begins a fresh progression
		}
		syncUrl();   // a recall/preset changed the patch — reflect it in the shareable URL
	}

	function recallMemory(n) {
		applyMemoryProfile(getMemoryProfile(n));
	}

	// Holding a Recall button for ≥3 s offers to CLEAR its profile (user
	// 2026-06-12): the hold timer fires while the button is still down and
	// puts up the system confirm; on OK the slot's stored value AND title
	// are emptied, which reverts both to the factory default (the slot is
	// never without a profile, so Recall stays enabled). _squelchClick eats
	// the release click that may slip through after the dialog, so a clear
	// can never be chased by an accidental recall. Releasing (or sliding
	// off) earlier cancels the timer and the ordinary click recalls as
	// before. Pointer events where available; mouse+touch pairs otherwise.
	// (The buttons carry user-select/touch-callout suppression in main.css
	// so a long iOS press doesn't pop the selection callout instead.)
	var RECALL_CLEAR_HOLD_MS = 3000;

	function clearMemory(n) {
		if (!window.confirm('Clear "' + getMemoryTitle(n) + '" and restore its default profile?')) { return; }
		lsSet("memory" + n, "");
		lsSet("memoryTitle" + n, "");
		var label = document.getElementById("memTitle" + n);
		if (label) { label.textContent = getMemoryTitle(n); }
	}

	function armRecallClearHold(btn, n) {
		var holdTimer = null;
		function beginHold() {
			cancelHold();
			btn._squelchClick = false;
			holdTimer = setTimeout(function () {
				holdTimer = null;
				btn._squelchClick = true;   // the button is still down — its release must not recall
				clearMemory(n);
			}, RECALL_CLEAR_HOLD_MS);
		}
		function cancelHold() {
			if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
		}
		if (window.PointerEvent) {
			btn.addEventListener("pointerdown", beginHold);
			btn.addEventListener("pointerup", cancelHold);
			btn.addEventListener("pointerleave", cancelHold);
			btn.addEventListener("pointercancel", cancelHold);
		} else {
			btn.addEventListener("mousedown", beginHold);
			btn.addEventListener("mouseup", cancelHold);
			btn.addEventListener("mouseleave", cancelHold);
			btn.addEventListener("touchstart", beginHold);
			btn.addEventListener("touchend", cancelHold);
			btn.addEventListener("touchcancel", cancelHold);
		}
	}

	// Editable profile titles (user 2026-06-12): each Store/Recall pair is
	// headed by a persistent name (memoryTitle3..6; every slot defaults to
	// "Empty" — its empty-state contents ARE the app defaults). The pencil
	// swaps the name for a text field; Enter just blurs, and the blur
	// commits — trimmed, an emptied field falls back to the default. iOS
	// doesn't reliably blur on an outside tap, so while editing a
	// capture-phase press listener on the document blurs the field for any
	// press that lands outside it.
	function memoryTitleDefault(n) {
		return "Empty";
	}

	function getMemoryTitle(n) {
		return lsGet("memoryTitle" + n) || memoryTitleDefault(n);
	}

	function setupMemoryTitle(n) {
		var row = qs("#memTitleRow" + n);
		var label = qs("#memTitle" + n);
		var pencil = qs("#memPencil" + n);
		var field = qs("#memTitleEdit" + n);
		label.textContent = getMemoryTitle(n);

		function outsidePress(e) {
			if (e.target !== field) { commit(); }
		}
		function watchOutside(on) {
			var fn = on ? "addEventListener" : "removeEventListener";
			if (window.PointerEvent) {
				document[fn]("pointerdown", outsidePress, true);
			} else {
				document[fn]("mousedown", outsidePress, true);
				document[fn]("touchstart", outsidePress, true);
			}
		}
		// Idempotent (the .editing check): Enter, blur and the outside press
		// all funnel here, and whichever fires first wins — commit must not
		// hinge on the blur event alone, because field.blur() is a silent
		// no-op whenever the focus() in the pencil handler didn't take.
		function commit() {
			if (!row.classList.contains("editing")) { return; }
			watchOutside(false);
			var v = field.value.replace(/^\s+|\s+$/g, "");
			if (!v) { v = memoryTitleDefault(n); }
			lsSet("memoryTitle" + n, v);
			label.textContent = v;
			row.classList.remove("editing");   // before blur(): re-entry via the blur listener exits on the check above
			field.blur();                      // dismisses the OS keyboard if it is still up
		}
		pencil.addEventListener("click", function () {
			field.value = getMemoryTitle(n);
			row.classList.add("editing");
			field.focus();   // inside the tap gesture, so iOS raises the keyboard
			field.select();
			watchOutside(true);
		});
		field.addEventListener("keydown", function (e) {
			if (e.key === "Enter" || e.keyCode === 13) { commit(); }
		});
		field.addEventListener("blur", commit);
	}

	function setupMemory() {
		// The permanent presets, in button order: Default (9, = the fresh-load
		// defaults, replacing the old "Reset to default"), Space Opera (1), Classic
		// (2), Celestial (7), Chamber (8), Drifter (10, a copy of Default —
		// user 2026-06-15). Plain recalls of the factory mixes — no Store/title.
		// (The 1968 preset was retired 2026-06-14; its Mixed/Mixed/chimes-7/Delay-on
		// settings are now the app defaults.)
		[9, 1, 2, 7, 8, 10].forEach(function (n) {
			qs("#memPreset" + n).addEventListener("click", function () {
				applyMemoryProfile(defaultMemoryProfile(n));
			});
		});
		MEMORY_SLOTS.forEach(function (n) {
			qs("#memStore" + n).addEventListener("click", function () { storeMemory(n); });
			var recall = qs("#memRecall" + n);
			recall.addEventListener("click", function () {
				if (recall._squelchClick) { recall._squelchClick = false; return; }
				recallMemory(n);
			});
			armRecallClearHold(recall, n);
			setupMemoryTitle(n);
		});
	}

	/* ---------- slide animation (settings panel + settings-box drawers) ---------- */
	// The animation is best-effort visual; the state change (done) is driven by a
	// guaranteed setTimeout so it never depends on an animation event firing.
	var SLIDE_MS = 200;

	function slideOpen(el, done) {
		el.style.display = "block";
		if (el.animate) {
			el.style.overflow = "hidden";
			el.animate(
				[{ height: "0px", opacity: 0 }, { height: el.scrollHeight + "px", opacity: 1 }],
				{ duration: SLIDE_MS, easing: "ease" }
			);
			setTimeout(function () {
				el.style.overflow = "";
				done();
			}, SLIDE_MS + 20);
		} else {
			done();
		}
	}

	function slideClosed(el, done) {
		if (el.animate) {
			el.style.overflow = "hidden";
			var anim = el.animate(
				[{ height: el.scrollHeight + "px", opacity: 1 }, { height: "0px", opacity: 0 }],
				{ duration: SLIDE_MS, easing: "ease", fill: "forwards" }
			);
			setTimeout(function () {
				anim.cancel();
				el.style.display = "none";
				el.style.height = "";
				el.style.overflow = "";
				done();
			}, SLIDE_MS + 20);
		} else {
			el.style.display = "none";
			done();
		}
	}

	/* ---------- per-instrument settings boxes (accordion) ---------- */
	// Each instrument (and vinyl) keeps its sliders in a collapsible
	// .settingsBoxDrawer beneath a summary header; the +/− toggle button is
	// the only control. Opening one box slides every other open box closed
	// (accordion), and all boxes start closed on every load — nothing is
	// persisted. Drawers animate with the same slideOpen/slideClosed as the
	// settings panel; a per-box flag ignores clicks mid-animation.
	function setBoxOpen(box, open) {
		if (box._animating) { return; }
		var drawer = box.querySelector(".settingsBoxDrawer");
		var btn = box.querySelector(".settingsBoxToggle");
		box._animating = true;
		if (open) { box.classList.add("open"); } else { box.classList.remove("open"); }
		btn.textContent = open ? "▲" : "▼";   // caret: up = open, down = closed
		btn.setAttribute("aria-expanded", open ? "true" : "false");
		(open ? slideOpen : slideClosed)(drawer, function () { box._animating = false; });
	}

	function setupSettingsBoxes() {
		qsa(".settingsBoxToggle").forEach(function (btn) {
			btn.addEventListener("click", function () {
				var box = btn.closest ? btn.closest(".settingsBox") : btn.parentNode.parentNode;
				if (!box) { return; }
				if (box.classList.contains("open")) {
					setBoxOpen(box, false);
				} else {
					qsa(".settingsBox.open").forEach(function (other) {
						if (other !== box) { setBoxOpen(other, false); }
					});
					setBoxOpen(box, true);
				}
			});
		});
		// (Removed 2026-06-16, user request: an outside tap no longer closes an open
		// box — only the box's own +/− toggle, or opening another box, closes it. The
		// old outside-close also fought the rotary dials, whose vertical drag ends with
		// the pointer outside the box and used to slam it shut on release.)
	}

	/* ---------- background / lock-screen playback (Media Session) ---------- */
	function setPlaybackState(state) {
		if ("mediaSession" in navigator) {
			try { navigator.mediaSession.playbackState = state; } catch (e) {}
		}
	}

	function setupMediaSession() {
		if (!("mediaSession" in navigator)) { return; }
		try {
			if (typeof MediaMetadata !== "undefined") {
				navigator.mediaSession.metadata = new MediaMetadata({
					title: "MiViAm",
					artist: "Mike's Vintage Ambient",
					artwork: [
						{ src: "img/icon-192.png", sizes: "192x192", type: "image/png" },
						{ src: "img/icon-512.png", sizes: "512x512", type: "image/png" }
					]
				});
			}
			// Lock-screen / hardware media keys map to the app's start/stop.
			// ⚠️ The play/pause GLYPH is rendered by the OS and cannot be
			// replaced with a stop icon (Media Session offers action handlers,
			// not icon control; play/pause is always shown — user asked
			// 2026-06-10). The pause control therefore performs a FULL STOP
			// (there is no resumable pause in this app), and "stop" is also
			// registered for surfaces that show a discrete stop control (e.g.
			// Chrome's desktop media hub). The pause handler must stay
			// registered: without it the OS would pause the elements directly
			// and the keep-alive auto-resume would fight the user's intent.
			navigator.mediaSession.setActionHandler("play", function () { if (!audioEnabled) { startAudio(); } });
			navigator.mediaSession.setActionHandler("pause", function () { if (audioEnabled) { stopAudio(); } });
			navigator.mediaSession.setActionHandler("stop", function () { if (audioEnabled) { stopAudio(); } });
		} catch (e) {}
	}

	/* ---------- install experience ---------- */
	// ONE affordance, never a pop-up (user 2026-06-11: "remove any pop up
	// prompting to install — leave the button in the advanced settings
	// section"): the "Install Locally" button in the advanced settings calls
	// the captured beforeinstallprompt, taking the user straight into the
	// browser's own install flow. On appinstalled we confirm it works
	// offline (#installedModal — a confirmation, not a prompt).
	// (Firefox never fires beforeinstallprompt — no install UI; iOS has no
	// prompt API at all, so since the instruction card was removed iOS gets
	// no install UI either — Add to Home Screen still works from Share.)
	var deferredInstallPrompt = null;
	var installed = false;          // appinstalled fired this session
	var installedOnDevice = false;  // getInstalledRelatedApps() saw the app THIS load (never persisted — a
	                                // persisted verdict deadlocked when Chrome withheld beforeinstallprompt
	                                // after an uninstall, hiding the button with no way back)

	function isStandalone() {
		return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
			window.navigator.standalone === true;   // iOS Safari home-screen flag
	}

	// Chromium (Chrome/Edge/etc.) exposes the install-prompt API even before the
	// event fires; Firefox/Safari don't. This lets us offer an install path on
	// Chromium even when the browser withholds beforeinstallprompt — it gates that
	// behind an engagement heuristic, and after an install→uninstall it can stay
	// quiet a while (which is why the button may need a reload to actually fire).
	function supportsInstallPrompt() {
		return "onbeforeinstallprompt" in window;
	}

	// iOS WebKit has installable PWAs but NO prompt API — no button can
	// trigger an install there; the only path is Share → Add to Home Screen.
	// Detected by FEATURE (navigator.standalone exists only on iOS WebKit;
	// ⛔ no UA sniffing), so iPhones get the row with instructions instead
	// of a button that could never work (user 2026-06-11: two iPhones showed
	// no install affordance at all).
	function isIOSWebKit() {
		return "standalone" in window.navigator;
	}

	// The settings row is the only affordance: on Chromium it carries the
	// working Install button + the PWA description; on iOS it carries the
	// manual Add-to-Home-Screen instructions (no button); everywhere an
	// install is implausible (already installed / running as the app /
	// no install path) it is hidden.
	function updateInstallUI() {
		var localRow = qs("#installLocallyRow");
		if (!localRow) { return; }
		var btn = qs("#installLocallyButton");
		var hint = qs("#installLocallyHint");
		var eligible = !installed && !installedOnDevice && !isStandalone();
		if (eligible && supportsInstallPrompt()) {
			localRow.style.display = "block";
			if (btn) { btn.style.display = ""; }
		} else if (eligible && isIOSWebKit()) {
			localRow.style.display = "block";
			if (btn) { btn.style.display = "none"; }
			if (hint) {
				hint.textContent = "This is a progressive web app: to install it on an " +
					"iPhone or iPad, tap the Share button and choose “Add to Home Screen”.";
			}
		} else {
			localRow.style.display = "none";
		}
	}

	function triggerInstall() {
		if (!deferredInstallPrompt) {
			// The prompt is single-use and was already spent this session (it
			// re-arms on the next visit). The PWA description above the button
			// is always visible now (user 2026-06-11), so nothing to reveal.
			return;
		}
		var p = deferredInstallPrompt;
		deferredInstallPrompt = null;             // a beforeinstallprompt event is single-use
		p.prompt();
		p.userChoice.then(function () { updateInstallUI(); });
	}

	function showInstalledPopup() {
		var modal = qs("#installedModal");
		if (!modal) { return; }
		modal.classList.add("show");
		setTimeout(function () { modal.classList.remove("show"); }, 8000);
	}

	function setupInstall() {
		// Hide the button when the app is detectably installed: running AS the
		// app (isStandalone), installed this session (appinstalled), or seen by
		// getInstalledRelatedApps() THIS load (needs the manifest's
		// related_applications self-entry). Deliberately NOT persisted: an
		// empty API result is not proof either way, and a remembered verdict
		// once deadlocked the button after an uninstall (Chrome withholds
		// beforeinstallprompt for a while, so nothing ever cleared the flag).
		if (navigator.getInstalledRelatedApps) {
			navigator.getInstalledRelatedApps().then(function (apps) {
				if (apps && apps.length) {
					installedOnDevice = true;
					updateInstallUI();
				}
			}).catch(function () {});
		}

		// Capture the install opportunity for the settings button.
		window.addEventListener("beforeinstallprompt", function (e) {
			e.preventDefault();
			deferredInstallPrompt = e;
			// Chrome never offers an install while the app IS installed, so
			// receiving this overrides any stale installed verdict.
			installedOnDevice = false;
			updateInstallUI();
		});

		qs("#installLocallyButton").addEventListener("click", triggerInstall);
		function closeInstalledModal() {
			qs("#installedModal").classList.remove("show");
		}
		qs("#installedModalClose").addEventListener("click", closeInstalledModal);
		qs("#installedModal").addEventListener("click", function (e) {
			if (e.target === qs("#installedModal")) { closeInstalledModal(); }   // backdrop tap only
		});

		// Installed (via our button or the browser UI). Chrome fires appinstalled
		// when the user ACCEPTS the prompt — before the app has finished
		// downloading/installing — and can fire again across the flow, which
		// double-showed the confirmation (once pre-, once post-install). So
		// appinstalled never opens the confirmation directly: it only arms a
		// pending flag, consumed by the standalone checks below the first time
		// the installed app actually presents.
		window.addEventListener("appinstalled", function () {
			installed = true;
			installedOnDevice = true;
			deferredInstallPrompt = null;
			lsSet("installConfirmPending", "1");
			updateInstallUI();
		});

		// Confirm installation exactly once, strictly AFTER the install
		// completed — i.e. when the app first runs standalone: a fresh launch of
		// the installed app (load-time check), or desktop Chrome morphing this
		// very tab into the app window without a reload (display-mode change).
		// The flag is only consumed in standalone, so a pending confirmation in
		// a still-open browser tab waits for the app's first launch; each fresh
		// install re-arms it; users whose install predates this build are never
		// shown it (their flag was never armed).
		function confirmInstallIfPending() {
			if (lsGet("installConfirmPending") !== "1") { return; }
			lsSet("installConfirmPending", "");
			showInstalledPopup();
		}
		if (isStandalone()) {
			confirmInstallIfPending();
		} else if (window.matchMedia) {
			var standaloneWatch = window.matchMedia("(display-mode: standalone)");
			var onDisplayModeChange = function (e) { if (e.matches) { confirmInstallIfPending(); } };
			if (standaloneWatch.addEventListener) { standaloneWatch.addEventListener("change", onDisplayModeChange); }
			else if (standaloneWatch.addListener) { standaloneWatch.addListener(onDisplayModeChange); }   // older WebKit
		}

		updateInstallUI();   // initial paint
	}

	/* ---------- init ---------- */
	function init() {
		// iOS Safari only applies the :active pseudo-class (the pressed-button
		// glow, main.css) while a touch listener exists somewhere — this no-op
		// is that listener (passive where supported; old engines treat the
		// options object as truthy capture, equally harmless for a no-op).
		try { document.addEventListener("touchstart", function () {}, { passive: true }); }
		catch (e) { document.addEventListener("touchstart", function () {}, false); }

		vinyl = qs("#vinylLoop");
		vinyl.addEventListener("ended", function () { vinyl.play(); }, false);
		ghost = qs("#keepAliveLoop");

		// iOS Safari 16.4+ (Audio Session API): declare long-form playback so
		// the system lets Web Audio and media elements keep running in the
		// background / on the lock screen. A no-op everywhere else.
		try {
			if (navigator.audioSession) { navigator.audioSession.type = "playback"; }
		} catch (e) {}

		// Distinguish a genuine audio-focus hand-off (the user started another
		// app/tab and it took over) from a background suspension we are meant to
		// survive (user 2026-06-14). A suspension pauses our keep-alive elements
		// ONCE and our resume holds; another app holding focus re-pauses us every
		// time we grab it back — a rapid pause→resume oscillation. So if an element
		// is paused more than FOCUS_YIELD_MAX times within FOCUS_YIELD_WINDOW_MS
		// (despite our resumes), conclude another app wants the audio and YIELD
		// completely (a full Stop) instead of fighting. A lone suspension stays
		// well under the threshold and still auto-resumes as before. startAudio
		// clears the per-element history, so each user Start gets a fresh budget.
		var FOCUS_YIELD_WINDOW_MS = 8000;
		var FOCUS_YIELD_MAX = 3;
		function shouldYieldAudioFocus(el) {
			var now = Date.now();
			var hist = el._pauseHist || (el._pauseHist = []);
			hist.push(now);
			while (hist.length && now - hist[0] > FOCUS_YIELD_WINDOW_MS) { hist.shift(); }
			return hist.length > FOCUS_YIELD_MAX;
		}

		// Same transient-interruption recovery as the vinyl bed below: if the
		// OS pauses the ghost while we're meant to be playing, resume it (a
		// user Stop sets audioEnabled=false first, so it never fights Stop) —
		// UNLESS the pauses are oscillating, which means another app genuinely
		// wants the audio, so we yield instead (shouldYieldAudioFocus).
		ghost.addEventListener("pause", function () {
			if (audioEnabled) {
				if (shouldYieldAudioFocus(ghost)) { stopAudio(); return; }
				setTimeout(function () {
					if (audioEnabled && ghost.paused) {
						ghost.play().catch(function () {});
					}
				}, 400);
			}
		});

		// Indefinite playback: a regular Start runs forever (no timer) until the user
		// hits Stop, starts the sleep timer, or closes the app. If a transient
		// interruption pauses the vinyl "bed" while we're meant to be playing, resume
		// it. A user Stop / sleep-end sets audioEnabled=false first, so it won't
		// resume; the 400ms debounce also lets a deliberate lock-screen pause win.
		vinyl.addEventListener("pause", function () {
			// Only fight a SPURIOUS pause (OS background / focus steal) — a deliberate
			// silence-pause (vinyl 0 / master 0) must stay paused and must not
			// count toward the focus-yield, so gate the whole recovery on vinylAudible().
			if (audioEnabled && vinylAudible()) {
				if (shouldYieldAudioFocus(vinyl)) { stopAudio(); return; }
				setTimeout(function () {
					if (audioEnabled && vinylAudible() && vinyl.paused) {
						vinyl.play().catch(function () {});
					}
				}, 400);
			}
		});

		setupMediaSession();
		setupInstall();
		setupSettingsBoxes();
		setupMemory();

		// Some OSes pause background media; when the page returns to the
		// foreground, re-assert playback if the app is meant to be playing.
		// The AudioContext now carries the vinyl bed as well as the instrument
		// notes, so also resume it if the OS suspended it in the background.
		document.addEventListener("visibilitychange", function () {
			if (!document.hidden && audioEnabled) {
				if (audioCtx && audioCtx.state === "suspended") { audioCtx.resume().catch(function () {}); }
				setVinylVolume();
				playGhost();
			}
		});

		qs("#startButton").addEventListener("click", startAudio);
		qs("#stopButton").addEventListener("click", stopAudio);
		qs("#sleepButton").addEventListener("click", startSleepTimer);

		// Firefox restores the disabled state of form controls across a reload
		// (and bfcache restore): after the user has played, a plain reload carries
		// the playing-state button config over — leaving Stop enabled even though
		// the engine is stopped (Chrome/WebKit don't do this). pageshow fires AFTER
		// the browser's form-state restoration on every load (normal + bfcache), so
		// re-assert the transport buttons to match the real engine state here. On a
		// normal reload the module re-inits with audioEnabled=false, which forces
		// the correct stopped state (Start + Sleep enabled, Stop disabled) and wins
		// over Firefox's restored disabled attributes.
		window.addEventListener("pageshow", function () {
			var playing = audioEnabled;
			qs("#startButton").disabled = playing;
			qs("#sleepButton").disabled = playing;
			qs("#stopButton").disabled = !playing;
		});

		qsa(".instrumentVol").forEach(function (slider) {
			slider.addEventListener("input", buildSoundArray);
		});

		// Balance / pan width: persist + relabel; playback reads the live slider
		// values at each play (panFor), so no rebuild is needed.
		qsa(".instrumentBalance, .instrumentPanWidth").forEach(function (slider) {
			slider.addEventListener("input", function () {
				lsSet(slider.id, slider.value);
				updateVolLabel(slider);
			});
		});

		qs("#vinylVol").addEventListener("input", function () {
			lsSet("vinylVol", qs("#vinylVol").value);
			setVinylVolume();
		});

		// Master volume: persist + relabel; the vinyl bed re-scales immediately and
		// the instrument mix re-scales live via the post-delay master fader
		// (applyMasterVol) — including the echo tails already ringing in the delay.
		qs("#masterVol").addEventListener("input", function () {
			lsSet("masterVol", qs("#masterVol").value);
			updateVolLabel(qs("#masterVol"));
			applyMasterVol();
			setVinylVolume();
		});

		qs("#totalSoundsSelect").addEventListener("change", function () {
			lsSet("totalSoundsSelect", qs("#totalSoundsSelect").value);
			// Re-arm the interval players at the new count — this must NOT go
			// through startAudio (non-reentrant; the engine keeps running and
			// the progression clock carries on untouched). Gate on audioEnabled
			// alone (v139): re-arm even while muted so the count isn't stranded
			// at the old value if you change it muted then un-mute.
			if (audioEnabled) {
				setSoundPlayerArray(parseInt(qs("#totalSoundsSelect").value, 10));
			}
		});

		// Playback mode (v72): persist; switching while playing is LIVE — notes
		// in flight decay naturally, the players simply start drawing from the
		// other mode's pool on their next tick. Entering chord mode mid-play
		// re-starts through a leading gap (restartChordGap) so the just-silenced
		// note tail / echoes don't overlap the first new chord; entering classic
		// clears any pending chord/gap timers so nothing fires later.
		qs("#modeSelect").addEventListener("change", function () {
			lsSet("mode", qs("#modeSelect").value);
			updateChordToneVisibility();
			if (audioEnabled && currentMode() === "chord") {
				restartChordGap();
			} else {
				clearChordTimers();
				currentChordPc = null;
			}
		});

		// Chord quality: persist; takes effect LIVE — the note pool reads the
		// formula at each use, so the progression clock and current root carry
		// on untouched.
		qs("#chordToneSelect").addEventListener("change", function () {
			lsSet("chordTone", qs("#chordToneSelect").value);
			// Switching INTO Random re-rolls the current chord's tone at once; for a
			// fixed tone rollChordTone is a no-op and currentChordFormula's live read
			// applies the new tone on the next note.
			rollChordTone();
		});

		// Classic note: persist; takes effect on the next note (the picker
		// reads the select at each play).
		qs("#classicNoteSelect").addEventListener("change", function () {
			lsSet("classicNote", qs("#classicNoteSelect").value);
		});

		// Speed (v137; 3-state 2026-06-14): persist; LIVE while playing. The per-note
		// playbackRate, the lowest-octave skip, AND the inter-note gap (armSoundPlayer
		// scales it by each note's own slow/normal draw) are all read live per note, so
		// the cadence adapts to the new speed on the very next note with NO re-arm. The
		// chord-state + gap clocks DO bake tempoMul()/speedCanSlow() in at arm time, so
		// re-arm the chord progression so its duration adopts the new speed at once
		// instead of finishing a stale cycle. Re-arm through restartChordGap (a leading
		// silent gap) rather than a bare startChordEngine so a slow note still ringing
		// from the outgoing chord — and, with Delay on, its echoes — decays before the
		// first new chord, instead of overlapping it (fix 2026-06-14, shared with the
		// Mode handler and Recall). (setSoundPlayerArray here just resets the players
		// cleanly.) Gate on audioEnabled ALONE: harmless while muted; instrumentsEnabled stranded it.
		qs("#speedSelect").addEventListener("change", function () {
			lsSet("speed", qs("#speedSelect").value);
			if (audioEnabled) {
				setSoundPlayerArray(parseInt(qs("#totalSoundsSelect").value, 10));
				if (currentMode() === "chord") { restartChordGap(); }
				else { clearChordTimers(); currentChordPc = null; }
			}
		});

		// Direction (2026-06-14): persist; takes effect on the NEXT note (the picker
		// reads currentDirection live), so no engine re-arm is needed.
		qs("#directionSelect").addEventListener("change", function () {
			lsSet("direction", qs("#directionSelect").value);
		});

		// Delay (2026-06-14): persist + apply live — just sets the shared delay taps'
		// gains (0 = off), so no engine re-arm and it takes effect mid-play.
		qs("#delayCheck").addEventListener("change", function () {
			lsSet("delay", qs("#delayCheck").checked ? "true" : "false");
			applyDelay();
		});

		qs("#showSettings").addEventListener("click", function () {
			if (!isAnimating) {
				isAnimating = true;
				settingsOpen = true;            // enable the fader flash
				lsSet("settingsOpen", "1");     // panel state persists across visits
				slideOpen(qs("#settings"), function () {
					qs("#showSettings").style.display = "none";
					qs("#hideSettings").style.display = "inline";
					isAnimating = false;
					refitAllSummaries();        // widths were 0 while the panel was hidden
				});
			}
		});

		// Orientation / window changes resize the boxes — refit the summaries
		// (debounced; cheap: 9 canvas measurements).
		var summaryResizeTimer = null;
		window.addEventListener("resize", function () {
			if (summaryResizeTimer) { clearTimeout(summaryResizeTimer); }
			summaryResizeTimer = setTimeout(function () {
				summaryResizeTimer = null;
				refitAllSummaries();
			}, 150);
		});

		qs("#hideSettings").addEventListener("click", function () {
			if (!isAnimating) {
				isAnimating = true;
				settingsOpen = false;           // stop flashing + clear any lit titles
				lsSet("settingsOpen", "0");
				clearTitleFlashes();
				slideClosed(qs("#settings"), function () {
					qs("#hideSettings").style.display = "none";
					qs("#showSettings").style.display = "inline";
					isAnimating = false;
				});
			}
		});

		// ---- loading gate (media elements only) ----
		// Reveal the controls once the 3 media ELEMENTS (two vinyl beds + the
		// ghost) are playable. Sampler files are NOT waited on any more — they
		// decode lazily per active instrument (v161/lazy-decode), so the gate is
		// just the old belt-and-braces media-element check (Firefox throttles
		// preloads and drops canplay events): immediate check, event listeners, a
		// readyState poll, a stall limit, and a hard backstop. finishLoading is
		// idempotent, so whichever path wins runs setup once; it then triggers the
		// first reconcile (via buildSoundArray) that starts decoding the active mix.
		var audios = qsa("audio");
		var totalToLoad = audios.length;   // only the 3 media elements gate startup now; samples decode lazily
		var loadingDone = false;
		var loadPoll = null;
		var loadCeiling = null;
		var lastReady = -1;
		var noProgressMs = 0;
		var POLL_MS = 400;
		var STALL_LIMIT_MS = 8000;    // proceed if the ready-count stops climbing this long
		var HARD_LIMIT_MS = 20000;    // absolute backstop so the loader can never hang forever

		function countReadyAndShowProgress() {
			var ready = 0, i;
			for (i = 0; i < audios.length; i++) {
				if (audios[i].readyState >= 3) { ready++; }
			}
			var pct = Math.ceil((ready * 100) / totalToLoad);
			qs("#loadingLabel").innerHTML = "tuning up (" + pct + "%)...";
			qs("#loadingProgressBar").style.width = pct + "%";
			return ready;
		}

		function finishLoading() {
			if (loadingDone) { return; }
			loadingDone = true;
			if (loadPoll) { clearInterval(loadPoll); loadPoll = null; }
			if (loadCeiling) { clearTimeout(loadCeiling); loadCeiling = null; }
			audios.forEach(function (a) { a.removeEventListener("canplay", onCanPlay); });
			restoreState();
			buildSoundArray();
			setVinylVolume();
			setupDials();   // present the instrument + vinyl sliders as rotary dials (once, post-restore)
			// Mirror every subsequent control change into the URL (#patch=) so it always
			// reflects the live patch; coalesced so a slider drag doesn't spam history.
			// (Programmatic changes — recall/preset — call syncUrl directly.)
			document.addEventListener("input", syncUrlSoon, true);
			document.addEventListener("change", syncUrlSoon, true);
			syncUrl();   // reflect the just-restored patch in the URL immediately
			// Restore the advanced-settings panel open/closed state (persisted on
			// every toggle; no slide animation on restore — it appears as left).
			var restoredOpen = lsGet("settingsOpen") === "1";
			if (restoredOpen) {
				settingsOpen = true;
				qs("#settings").style.display = "block";
				qs("#showSettings").style.display = "none";
				qs("#hideSettings").style.display = "inline";
			}
			qs("#loadingIndicator").style.display = "none";
			qs("#controls").style.display = "block";
			// The summaries can only be fitted AFTER #controls (the panel's
			// ancestor) is visible — inside display:none every clientWidth is
			// 0 and fitSummary skips, leaving the tiny CSS-ladder fallback on
			// phones until the next resize (the Android "tiny fonts until you
			// scroll the URL bar away" bug, user 2026-06-11).
			if (restoredOpen) { refitAllSummaries(); }
		}

		function onCanPlay() {                         // event-driven: snappy completion
			if (loadingDone) { return; }
			if (countReadyAndShowProgress() >= totalToLoad) { finishLoading(); }
		}

		function pollTick() {                          // timer-driven: catches missed events + stalls
			if (loadingDone) { return; }
			var ready = countReadyAndShowProgress();
			if (ready >= totalToLoad) { finishLoading(); return; }
			if (ready === lastReady) {
				noProgressMs += POLL_MS;
				if (noProgressMs >= STALL_LIMIT_MS && ready > 0) { finishLoading(); }
			} else {
				lastReady = ready;
				noProgressMs = 0;
			}
		}

		ensureAudioContext();                          // suspended is fine — it can decode samples on demand later
		// Samples decode lazily now (finishLoading → restoreState → buildSoundArray
		// → reconcile loads the active instruments); the gate only waits for the 3
		// media elements (vinyl beds + ghost), so controls appear fast.
		audios.forEach(function (a) { a.addEventListener("canplay", onCanPlay); });
		onCanPlay();                                   // catch media already ready (e.g. cached)
		loadPoll = setInterval(pollTick, POLL_MS);     // catch missed/throttled canplay events
		loadCeiling = setTimeout(finishLoading, HARD_LIMIT_MS);   // absolute anti-hang backstop
	}

	// Read-only debug handle for headless verification (NOT a public API —
	// nothing in the app reads it, and it exposes no setters).
	window._miviam = {
		get mode() { return currentMode(); },
		get chordTone() { var s = qs("#chordToneSelect"); return s ? s.value : null; },
		get chordToneActive() { return chordToneIsRandom() ? currentRandomToneKey : (qs("#chordToneSelect") ? qs("#chordToneSelect").value : null); },
		rollChordTone: rollChordTone,
		get classicNote() { return currentClassicNote(); },
		get chordPc() { return currentChordPc; },
		notesForPc: notesForPc,
		pickNextChordPc: pickNextChordPc,
		get samplesLoaded() { return Object.keys(sampleBuffers).length; },   // now: live decoded count (lazy)
		get samplesTotal() { return samplesTotal; },
		get buffersDecoded() { return Object.keys(sampleBuffers).length; },
		get loadedKeys() { return Object.keys(sampleBuffers).slice().sort(); },   // which samples are currently decoded
		get pendingLoads() { return Object.keys(pendingLoads).slice().sort(); },
		reconcileSamples: reconcileSamples,   // force a synchronous reconcile (bypasses the debounce) for tests
		get maxSampleSeconds() { return maxSampleSeconds; },
		get gapMs() { return gapMs(); },
		get sampleRetries() { return sampleRetries; },
		get samplesFailed() { return samplesFailed; },
		get masterScale() { return masterScale(); },
		get masterBus() { return !!compressorNode; },                       // limiter created + in the path?
		get appMuteGain() { return appMuteGain ? appMuteGain.gain.value : null; },   // 0 stopped / 1 running
		get limiterReduction() { return compressorNode ? compressorNode.reduction : null; },  // live gain reduction, dB (≤0)
		get noteLog() { return noteLog.slice(); },
		samplerFor: samplerFor,
		slowModeOn: slowModeOn,
		get speed() { return currentSpeed(); },
		noteIsSlow: noteIsSlow,
		tempoMul: tempoMul,
		fluteHighGain: fluteHighGain,
		get fluteHighFloor() { return FLUTE_HIGH_FLOOR; },
		get direction() { return currentDirection(); },
		get delayOn() { return delayOn(); },
		get delayBuilt() { return !!instrumentBus; },
		get masterVolGain() { return masterVolNode ? masterVolNode.gain.value : null; },   // post-delay master fader level (= masterScale once built)
		get delayTapGains() { return delayTaps.map(function (g) { return g.gain.value; }); },
		get delayTimes() { return delayNodes.map(function (d) { return d.delayTime.value; }); },
		buildDelay: function () { ensureAudioContext(); return !!instrumentBusTarget(); },   // force-build for headless tests
		get vinylAudible() { return vinylAudible(); },   // would the bed be heard? (false => beds paused)
		get vinylPaused() { return vinyl.paused; },
		bufferFor: function (prefix, rootNote) { return sampleBuffers[prefix + ":" + rootNote] || null; },
		reversedBufferFor: function (prefix, rootNote) { return reversedBufferFor(prefix + ":" + rootNote); }
	};

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", init);
	} else {
		init();
	}
})();

/* PWA: register the service worker (progressive enhancement; failures are silent).
   Skip entirely inside a browser-extension build (chrome-extension:/moz-extension:):
   the extension packages all assets, so a page service worker is both unnecessary
   and disallowed by the extension origin. The guard is a no-op on the live https
   site, where the SW still registers exactly as before. */
if ("serviceWorker" in navigator &&
    location.protocol !== "chrome-extension:" &&
    location.protocol !== "moz-extension:") {
	window.addEventListener("load", function () {
		navigator.serviceWorker.register("service-worker.js").catch(function () {});
	});
}
