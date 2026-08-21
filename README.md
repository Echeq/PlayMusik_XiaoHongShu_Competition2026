

# Play Musik 🎵
<p align="center">
  <img src="src/image/favicon.svg" alt="Play Musik" width="96" height="96">
</p>
An **Incredibox-style** beat maker built with pure HTML, CSS, and vanilla JavaScript. Click characters to activate loops and mix a beat. **100% offline** — every sound is synthesized in your browser with the Web Audio API, with zero internet connection.

## Features

### Kits (11 kits, 125 characters)

- **Origin** (12): the classic crew — Kick, Snare, Hi-Hat / Scratch, Boom, Zap / Bass, Lead, Arp / Chant, Beatbox, Ooh.
- **Neon** (12): the electric crew — Toms, Clap, Shaker / Air Horn, Vinyl Scratch, Riser / Piano, Pluck, Chiptune / Hey, Yeah, Whistle.
- **World** (8): organic percussion and voices — Congas, Cowbell, Tambourine / Djembe, Rainstick / Pan Flute / Choir, Opera.
- **Circuit** (11): electronic toolkit — 808 Sub, Crash, Rimshot / Drum Glitch, Filter Sweep, Sidechain / Synth Pad, Music Box, Wobble Bass, Strings / Talkbox.
- **Jazz** (12): the smoky late-night crew — Ride, Brushes, Kick / Rim, Splash, Wah / Walking Bass, Comp, Sax / Scat, Hum, Bop.
- **RNB** (12): smooth grooves — Kick, Snare, Hi-Hat / Rim, Shaker, Crackle / Rhodes, Smooth Bass, Guitar / Soul, Adlib, Ooh.
- **Salsa** (12): the fiery Latin crew — Congas, Timbales, Bongo, Clave / Güiro, Maracas, Campana / Montuno, Tumbao, Brass / Coro, Soneo.
- **BOSSA NOVA** (12): Brazilian acoustic warmth — Kick, Brush, Shaker, Tamborim / Guitar, Pandeiro, Agogô / Piano, Sax, Bass / Voice, Choir.
- **KPOP** (12): bright production — Kick, Snare, Hi-Hat, Clap / Riser, Drop, FX / Synth Lead, Piano, Bass / Vocal, Chant.
- **TRAP** (11): dark heavy 808 — 808, Snare, Hi-Hat, Clap / Roll, Riser, FX / Synth, Piano, Bass / Adlibs.
- **LOFI** (11): dusty nostalgia — Kick, Snare, Hi-Hat, Vinyl / Rain, Tape, Pop / Piano, Guitar, Bass / Vocal.

Each character has its own **rhythmic pattern** (16 steps) and its own **synthesized sound** (Web Audio API, zero audio files).

### Dynamic behaviors

- **One-shot**: Toms, Air Horn, Riser, Crash, Splash, and the KPOP/TRAP risers & drops fire once on click (they never enter the loop).
- **Intensity**: hold a character to fire an extra accent (flam).
- **Random**: activates a random mix of characters.
- **Probability**: any character with a `P` badge can enable its random gate — its notes play with an X% chance per cycle.
- **Ghost Notes**: Shaker (echo of Clap) and Tambourine (echo of Congas) duplicate another character's pattern with a micro-delay.
- **Call & Response**: melodies answer the active beats rhythmically.
- **Gold Character**: Zap, Chant, Whistle, Pan Flute, Sax, Rhodes, and Brass (★) change their sound based on secret combos of active characters.
- **Auto-pan**: Hi-Hat, Arp, Shaker, Tambourine, Music Box, and others alternate L/R; Congas, Cowbell, and Strings have a fixed position.

### Transport & mixing

- Play/Stop, **BPM** slider (60–180), visual step indicator.
- **Per-row mute and volume** + master.
- **Filter Sweep** and **Sidechain** modulate global nodes of the audio chain.
- State persisted in `localStorage` (active characters, probabilities, BPM, rows, time signature).
- Basic accessibility: `aria-pressed`, `aria-label`, keyboard (spacebar for Play/Stop).

## How to run

No installation, build, or server required. Two options:

1. **Direct**: open `index.html` in your browser (works from `file://`).
2. **Local**: serve the folder with any static server, e.g.:
   ```
   python -m http.server 8000
   ```
   and open `http://localhost:8000`.

## How to use

1. Pick a **kit** from the top bar (Origin / Neon / World / Circuit / Jazz / RNB / Salsa / BOSSA NOVA / KPOP / TRAP / LOFI).
2. Click a character to activate it (click again to mute it). One-shots sound on click.
3. Press **Play** (or the spacebar) to hear the loops in sync.
4. Adjust the **BPM** to change the tempo.
5. Use the **mute/volume** panel on each row to mix.
6. Try **Random**, the **P** badges (probability), and the **★** characters (secret combos).

## Project structure

```
index.html                App entry (logo, grid, transport, Home, settings modal)
src/
  css/styles.css          Styles: visual identity, grid, animations, Home
  js/data.js              Config for the 11 kits and 125 characters (name, row, pattern, synth, flags)
  js/audio-engine.js      Audio engine: Web Audio synthesis + scheduler + global FX
  js/i18n.js              zh/en/es translations + data-i18n binder
  js/main.js              UI: grid, transport, Home, modal, localStorage
  image/                  favicon.svg, logo.gif, optional bg.png
  audio/                  Reserved for future samples (empty)
LICENSE                   MIT License
```

## How the audio works

- **A single `AudioContext`**, created on the first user gesture (browser requirement).
- **Gain chain**: `4 row gains → master → masterFilter (BiquadFilter) → sidechainGain → compressor → destination`. Filter Sweep modulates `masterFilter`; Sidechain modulates `sidechainGain`.
- **Lookahead scheduler** ("A Tale of Two Clocks"): a 25 ms `setInterval` schedules notes ~100 ms ahead of `audioContext.currentTime`, keeping loops sample-accurate and synced to the BPM.
- **Pure runtime synthesis**: kick (sine with pitch drop), snare/hi-hat (filtered noise), bass/lead/arp (oscillators with note sequences), voices (formants + vibrato), pads (detuned saws), effects (noise + filters). No audio files.
- **Auto-pan**: characters with `pan: 'alt'` route their output through a `StereoPannerNode` that alternates L/R.

## Offline guarantee

- No CDN, no `fetch`/`XMLHttpRequest` to remote servers, no external fonts or images.
- Favicon and icons 100% local/inline; characters use inline SVG.
- Optional backdrop `src/image/bg.png` (if missing, the neon gradients keep the look).
- Verified in DevTools offline mode and from `file://`.

## Persistence

State is saved under the `musiclike-state-v2` key in `localStorage`. Clear the site data in DevTools to reset.

## License

**Play Musik** is open-source software under the **MIT License** (see `LICENSE`).

- **Author:** ELVIS ENRIQUE CHEN QIU — Panama
- **Usage:** free to use, modify, distribute, and share, with attribution.
- **Warranty:** the software is provided "as is", without warranty of any kind.
