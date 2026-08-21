# AGENTS.md

## Project

**Play Musik** — an Incredibox-style beat-making app (click characters to mix loops/samples) built with pure HTML, CSS, and vanilla JavaScript. No frameworks, no build tools, no package manager.

## Non-negotiable constraint: 100% offline

The app must work with **zero network access**. Never add anything that requires internet:

- No CDN `<link>`/`<script>` (no Google Fonts, no Bootstrap, no jQuery CDN).
- No external images, audio, or video URLs. Favicon and icons are inline/data-URI.
- No `fetch`/`XMLHttpRequest` to remote hosts.
- Fonts and audio must be bundled locally. Verify changes in DevTools offline mode and from `file://`.

Audio strategy: the **Web Audio API** synthesizes all loops/samples at runtime (no audio files). A single `AudioContext` is created lazily on the first user gesture (browser requirement) and resumed there — keep this pattern.

## Layout

```
index.html             entry point; loads 4 scripts in this order (below)
src/css/styles.css     all styles (bg.png backdrop optional, falls back if missing)
src/js/data.js         PlayMusikData — 11 kits, 125 characters (name, row, 16-char pattern, synth, flags)
src/js/audio-engine.js PlayMusikAudio — Web Audio synth, scheduler, FX chain
src/js/i18n.js         PlayMusikI18n — zh/en/es dictionaries, data-i18n binder
src/js/main.js         UI: kit pills + Home panel, grid, transport, settings modal, localStorage
src/image/             favicon.svg + logo.gif (referenced by index.html); bg.png optional backdrop
src/audio/             reserved for future bundled samples (currently empty)
```

## Script model (important)

- The four scripts are **classic scripts** (IIFE-style, attach globals `PlayMusikData`, `PlayMusikAudio`, `PlayMusikI18n`), **not ES modules**.
- Load order in `index.html` matters: `data.js` → `audio-engine.js` → `i18n.js` → `main.js`. `main.js` depends on all three globals.
- Match this style: no `import`/`export`, no bundler. Only edit `index.html` if you actually add/remove a script.
- The settings modal in `index.html` **must stay before the scripts**: `main.js` grabs its DOM refs synchronously at IIFE time, so moving the modal after the scripts breaks the app.

## Adding a character / kit

A character is data-driven but needs three coordinated pieces or it breaks quietly:

- `src/js/data.js` — a `{ id, name, row: 0-3, synth, pattern, flags }` entry in a kit. `row` must map to one of the 4 rows in `data.rows`; `pattern` is exactly 16 chars. The header comment documents all flags (`oneShot`, `prob`, `ghostOf`, `gold`/`goldCombos`, `pan`).
- `src/js/audio-engine.js` — a matching preset in the `synths` registry keyed by the `synth` id. There is **no error if it's missing**: the scheduler guards with `if (fn)` and the character silently makes no sound.
- `src/js/main.js` — an entry in the `ICONS` map, or the card renders a blank icon (`ICONS[ch.id] || ''`).

Also: the Home landing panel and the settings modal (Credits/Language sub-panels) live in `index.html` and are wired in `main.js` — new UI text must follow the i18n rules below.

## i18n conventions

- Default language is `zh`; dictionaries live in `src/js/i18n.js` as `DICTS.zh/en/es`. Any new UI string must be added to **all three** dicts.
- Static text uses `data-i18n` (textContent), `data-i18n-title` (title), `data-i18n-aria` (aria-label) attributes in `index.html`.
- Dynamic strings (character names, etc.) are re-rendered through `PlayMusikI18n.onApply = refreshI18n` in `main.js` — register new dynamic text there.
- Language choice persists under the separate localStorage key `musiclike-lang` (not the state key).

## Persistence

State is saved under the localStorage key `musiclike-state-v2` (current kit, active characters per kit, probability toggles, BPM, time signature, row mute/volume). Changing this key breaks saved states — only do so intentionally with a migration.

## Audio

- Gain chain (verified in `audio-engine.js`): 4 row gains → `master` → `masterFilter` (lowpass) → `sidechainGain` → compressor → destination. Filter Sweep modulates `masterFilter`; Sidechain modulates `sidechainGain`.
- Time signature is a runtime state (`2/4` = 8 steps, `3/4` = 12, `4/4` = 16) set via `audio.setTimeSignature(sig)`; default `4/4`.

## Commands

No install, build, test, or lint commands. Run by opening `index.html` directly, or serve the folder locally with `python -m http.server 8000` (loopback only — never touches the internet).

## Not app code — don't touch unless asked

- `agent/`, `.agents/` — OpenCode COMMANDER agent definitions and memory (see `opencode.json`).
- `docs/` — scratch/idea notes.
