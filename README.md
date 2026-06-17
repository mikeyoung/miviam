<p align="center">
  <img src="img/title.png" alt="MiViAm — Mike's Vintage Ambient" width="420" />
</p>

# MiViAm — Mike's Vintage Ambient

**Soothing ambient sound chimes with a sleep timer.** An endless, non‑repeating stream of relaxing vintage‑instrument notes drifting over a bed of warm vinyl‑record surface noise.

🔊 **Live app:** https://mikeyoung.org/miviam/
🎬 **Early video demo:** https://youtu.be/mNCxTsWdmJI _(shows an earlier version; the app has grown a lot since)_

MiViAm is a browser‑based reimagining of the classic (and no longer available) iOS and Chrome "MiViAm" apps. It runs in any modern browser, installs as an offline app, and is deliberately light on network and local resources. Because every sequence is generated on the fly and never repeats, there's no pattern to lock onto and tire of — it's meant to fade into the background.

---

## Features

**Sound engine**
- **Eight vintage instruments** — Höfner bass, cello, Fender Rhodes, vibes, celeste, Mellotron MkII flute, violins, and choir — each sampled across 12 root notes and pitch‑shifted in real time.
- **Vinyl bed** — a continuous lo‑fi LP surface‑noise layer for warmth and texture, with its own level.
- **Per‑instrument mixing** — volume, stereo **balance**, and **pan width** for every channel, plus **Mute/Unmute** and **Solo**.
- **Master volume** and **chime frequency** (how densely notes fall).

**Generative playback**
- **Two modes** — **Chord** (the default): a slowly evolving chord wheel that holds one chord for a few minutes, falls briefly silent, then moves to a new random chord; and **Classic**: the original single‑note ambient texture.
- **Chord Tone** — **Random** (default), Major, Minor, Dom 7, Maj 7, or Sus 4. Random picks a fresh quality for each new chord.
- **Speed** — Normal, Slow, or Mixed (per‑note).
- **Direction** — Forward, Reversed, or Mixed (per‑note reversed playback).
- **Delay** — a gentle multi‑tap echo on the instruments, on by default.

**Comfort & convenience**
- **Sleep timer** — fades everything out after up to 60 minutes.
- **Presets** — five one‑tap factory mixes: **Default**, **Space Opera**, **Classic**, **Celestial**, and **Chamber**.
- **Memory slots** — four user slots to **Store** / **Recall** your own mixes (rename them; press‑and‑hold a slot to clear it).
- **Shareable patches** — the complete state of every control is encoded in the page URL (`#patch=…`), so you can **share a sound just by copying the link**.
- **Installable & offline** — a Progressive Web App: install it to your home screen or desktop and it runs without a network connection.
- **Remembers your settings** between visits (stored locally in your browser).

---

## Using the app

1. Open the [live app](https://mikeyoung.org/miviam/) and press **Start**.
2. Open **Settings** to shape the sound — adjust instrument levels, pick a mode and chord tone, tweak speed/direction/delay, or load a preset.
3. Press **Sleep** to start the timer (or stop playback).
4. Found a mix you love? **Copy the URL** to share it, or **Store** it to a memory slot.

### Installing (PWA)

In a supporting browser, visit the live site and choose **Install** (desktop) or **Add to Home Screen** (mobile). After the first load it works fully offline.

---

## Running locally

MiViAm is a **static site with no build step** — just serve the folder over HTTP and open it. (A service worker powers offline/PWA, so it must be served over `http://localhost` or `https://`; opening `index.html` directly from `file://` won't register the service worker.)

```bash
# Python 3
python -m http.server 8553
# → open http://localhost:8553/

# …or any static server, e.g.
npx serve
```

---

## Tech stack

- **Vanilla JavaScript** — no framework, no jQuery, **no build step**. Settings are kept in sync with the controls by hand; at this scale that's simpler than adding React/Vue and a toolchain (and it keeps the dependency and security surface tiny).
- **Web Audio API** — a buffer‑based sampler: each note is an `AudioBufferSourceNode` pitch‑shifted via `playbackRate`, routed through per‑note gain/pan into a shared instrument bus, a multi‑tap delay, and a master limiter.
- **Service Worker + Web App Manifest** — offline app‑shell precaching plus a runtime audio cache; installable as a PWA.
- **`localStorage`** — persists your last settings.
- **Responsive by proportion** — the layout centers and scales to the viewport (no CSS breakpoints or Bootstrap).

### Project structure

```
index.html             UI markup
js/main.js             all app logic (one self-contained module)
main.css               styles
service-worker.js      offline app-shell + runtime audio cache
manifest.webmanifest   PWA manifest
img/                   icons + background art
snd/                   audio samples (mp3) + the vinyl bed
extension/             optional Chrome/Firefox extension wrapper (source + build script)
```

---

## Browser support

Built and tested for **Firefox and Chrome** (and other Chromium browsers) across **Windows, macOS, Linux, Android, and iOS** (Safari/WebKit). A Web Audio–capable browser is required. Audio ships as **MP3**, which every current target supports.

---

## Audio & credits

The Mellotron sounds were sourced from the **GForce Mellotron VSTi** — they did an incredible job with that instrument and deserve much of the credit for how lovely the tones are. The electric piano is a **Fender Rhodes** and the bass is a **Höfner**.

Each sample was EQ'd to favour the midrange and compressed so the instruments share a similar frequency band. The Mellotron already has much of its high and low end rolled off — likely a limitation of the original hardware rather than a design choice. **If you add your own sounds**, note that you may want to replace the defaults entirely for a broader dynamic range, or compress new sounds to match this style. Also note that the chime‑rate scheduling assumes samples stay under a certain length.

---

## Contributing & reuse

This project started as a small personal app and is shared in that spirit — **feel free to extend, remix, or completely change it.** The original intent is *ambient*: no rhythm, no pattern, nothing to anticipate. Issues and pull requests are welcome.

If something isn't working for you, please open an issue. Thanks for listening! 🎧
