/* ==========================================================================
   Play Musik — data.js
   Source of truth for every kit and character: name, row, 16-step pattern,
   and the synth preset used by the audio engine.

   Pattern syntax: a string of exactly 16 chars. '.' = rest; any of
   'x'/'X' (hit), 'o' (accent), 'g' (ghost stroke), 'f' (fill) = play.

   Structure:
   - rows:   the 4 shared row definitions (Beats / Effects / Melodies / Voices)
   - kits:   an array of kits; each kit has its own 12-slot character roster
             that fills the same 4x3 grid. Switching kits rebuilds the grid.

   Optional character flags (used by the dynamic layers):
   - oneShot:  fire once on click instead of looping
   - prob:     per-character random probability (Wave 4)
   - ghostOf:  duplicates another character's pattern with micro-delay
   - gold:     sound changes based on secret combos of active characters
   - goldCombos: list of { ids: [...], synth: '...' } combo unlocks
   - pan:      'alt' = auto-alternate L/R, or a fixed value -1..1 (Wave 5)
   ========================================================================== */

'use strict';

var PlayMusikData = {
  bpm: 100,
  rows: [
    { id: 'beats',    name: 'Beats',    color: '#ff5d5d' },
    { id: 'effects',  name: 'Effects',  color: '#ffc145' },
    { id: 'melodies', name: 'Melodies', color: '#4db8ff' },
    { id: 'voices',   name: 'Voices',   color: '#4ade80' }
  ],
  kits: [
    /* ======================================================================
       Kit 1 — Origin (the original 12)
       ====================================================================== */
    {
      id: 'origin',
      name: 'Origin',
      blurb: 'The original crew — classic beat foundations.',
      characters: [
        /* ---- Row 0: Beats (red) ---- */
        { id: 'kick',    name: 'Thump',   row: 0, synth: 'kick',    pattern: 'X..X.X..X..X.X..' },
        { id: 'snare',   name: 'Crack',   row: 0, synth: 'snare',   pattern: '....X...X...X...' },
        { id: 'hihat',   name: 'Tick',    row: 0, synth: 'hihat',   pattern: 'X.X.X.X.X.X.X.X.', pan: 'alt' },

        /* ---- Row 1: Effects (yellow) ---- */
        { id: 'scratch', name: 'Skratch', row: 1, synth: 'scratch', pattern: '..X...X...X.X...' },
        { id: 'boom',    name: 'Kaboom',  row: 1, synth: 'boom',    pattern: 'X...............' },
        { id: 'zap',     name: 'Zing',    row: 1, synth: 'zap',     pattern: '....X...X.......',
          gold: true,
          goldCombos: [
            { ids: ['kick', 'snare', 'hihat'], synth: 'zapGoldBeat' },
            { ids: ['bass', 'lead', 'arp'],     synth: 'zapGoldMelody' },
            { ids: ['chant', 'beatbox', 'ooh'], synth: 'zapGoldVoice' }
          ] },

        /* ---- Row 2: Melodies (blue) ---- */
        { id: 'bass',    name: 'Throb',   row: 2, synth: 'bass',    pattern: 'X..X..X..X..X.X.' },
        { id: 'lead',    name: 'Soar',    row: 2, synth: 'lead',    pattern: '....X...X...X..X' },
        { id: 'arp',     name: 'Twinkle', row: 2, synth: 'arp',     pattern: 'X.X.X.X.X.X.X.X.', pan: 'alt' },

        /* ---- Row 3: Voices (green) ---- */
        { id: 'chant',   name: 'Mantra',  row: 3, synth: 'chant',   pattern: '....X.......X...',
          gold: true,
          goldCombos: [
            { ids: ['kick', 'snare', 'hihat'], synth: 'chantGoldBeat' },
            { ids: ['bass', 'lead', 'arp'],     synth: 'chantGoldMelody' },
            { ids: ['beatbox', 'ooh'],          synth: 'chantGoldVoice' }
          ] },
        { id: 'beatbox', name: 'VoxBox',  row: 3, synth: 'beatbox', pattern: 'X..X..X..X..X.X.' },
        { id: 'ooh',     name: 'Ahh',     row: 3, synth: 'ooh',     pattern: 'X.....X.....X...' }
      ]
    },

    /* ======================================================================
       Kit 2 — Neon (the electric crew)
       ====================================================================== */
    {
      id: 'neon',
      name: 'Neon',
      blurb: 'Electric crew — bright, synthetic, and loud.',
      characters: [
        /* ---- Row 0: Beats (red) ---- */
        { id: 'toms',    name: 'DunDun',    row: 0, synth: 'toms',    pattern: 'X..X..X..X..X...', oneShot: true },
        { id: 'clap',    name: 'High Five', row: 0, synth: 'clap',    pattern: '....X...X...X...' },
        { id: 'shaker',  name: 'Shimmy',    row: 0, synth: 'shaker',  pattern: 'X.X.X.X.X.X.X.X.',
          prob: 0.6, ghostOf: 'clap', ghostDelay: 0.03, pan: 'alt' },

        /* ---- Row 1: Effects (yellow) ---- */
        { id: 'airhorn', name: 'Bwah',      row: 1, synth: 'airhorn', pattern: 'X...............', oneShot: true },
        { id: 'vinyl',   name: 'Skrrt',     row: 1, synth: 'vinyl', pattern: '..X...X...X.X...' },
        { id: 'riser',   name: 'Whoosh',    row: 1, synth: 'riser',   pattern: '....X...X.......', oneShot: true },

        /* ---- Row 2: Melodies (blue) ---- */
        { id: 'piano',   name: 'Ivory',     row: 2, synth: 'piano',   pattern: '....X...X...X..X' },
        { id: 'pluck',   name: 'Ping',      row: 2, synth: 'pluck',   pattern: 'X.X.X.X.X.X.X.X.', prob: 0.5 },
        { id: 'chiptune', name: 'Beep',     row: 2, synth: 'chiptune', pattern: 'X..X..X..X..X.X.' },

        /* ---- Row 3: Voices (green) ---- */
        { id: 'hey',     name: 'Yo',        row: 3, synth: 'hey',     pattern: '....X.......X...' },
        { id: 'yeah',    name: 'Woo',       row: 3, synth: 'yeah',    pattern: 'X.....X.....X...' },
        { id: 'whistle', name: 'Tweet',     row: 3, synth: 'whistle', pattern: 'X..X..X..X..X.X.', prob: 0.4,
          gold: true,
          goldCombos: [
            { ids: ['toms', 'clap', 'shaker'],     synth: 'whistleGoldBeat' },
            { ids: ['piano', 'pluck', 'chiptune'], synth: 'whistleGoldMelody' },
            { ids: ['hey', 'yeah'],                synth: 'whistleGoldVoice' }
          ] }
      ]
    },

    /* ======================================================================
       Kit 3 — World (organic instruments, sung voices)
       ====================================================================== */
    {
      id: 'world',
      name: 'World',
      blurb: 'Organic crew — hand percussion, flutes, and voices.',
      characters: [
        /* ---- Row 0: Beats (red) ---- */
        { id: 'congas',    name: 'Tumba',    row: 0, synth: 'congas',    pattern: 'X..X..X..X..X...', pan: -0.4 },
        { id: 'cowbell',   name: 'MooBell',  row: 0, synth: 'cowbell',   pattern: '....X...X...X...', pan: 0.4 },
        { id: 'tambourine', name: 'Jingle',  row: 0, synth: 'tambourine', pattern: 'X.X.X.X.X.X.X.X.',
          prob: 0.6, ghostOf: 'congas', ghostDelay: 0.03, pan: 'alt' },

        /* ---- Row 1: Effects (yellow) ---- */
        { id: 'djembe',    name: 'Slap',    row: 1, synth: 'djembe',    pattern: 'X...X...X..X.X..' },
        { id: 'rainstick', name: 'Pitter',  row: 1, synth: 'rainstick', pattern: 'X.X.X.X.X.X.X.X.' },

        /* ---- Row 2: Melodies (blue) ---- */
        { id: 'panflute',  name: 'Breeze',  row: 2, synth: 'panflute', pattern: '....X...X...X..X',
          gold: true,
          goldCombos: [
            { ids: ['congas', 'cowbell', 'tambourine'], synth: 'panfluteGoldBeat' },
            { ids: ['djembe', 'rainstick'],              synth: 'panfluteGoldFX' },
            { ids: ['choir', 'opera'],                   synth: 'panfluteGoldVoice' }
          ] },

        /* ---- Row 3: Voices (green) ---- */
        { id: 'choir',     name: 'Angels',  row: 3, synth: 'choir',    pattern: 'X.....X.....X...' },
        { id: 'opera',     name: 'Diva',    row: 3, synth: 'opera',    pattern: '....X.......X...' }
      ]
    },

    /* ======================================================================
       Kit 4 — Circuit (electronic toolkit)
       ====================================================================== */
    {
      id: 'circuit',
      name: 'Circuit',
      blurb: 'Electronic toolkit — 808s, glitches, and synth textures.',
      characters: [
        /* ---- Row 0: Beats (red) ---- */
        { id: 'sub808',    name: 'Rumble',    row: 0, synth: 'sub808',  pattern: 'X..X..X..X..X...' },
        { id: 'crash',     name: 'Smash',     row: 0, synth: 'crash',   pattern: '....X.......X...', oneShot: true },
        { id: 'rimshot',   name: 'Pock',      row: 0, synth: 'rimshot', pattern: '..X...X...X.X...' },

        /* ---- Row 1: Effects (yellow) ---- */
        { id: 'glitch',    name: 'Fizz',      row: 1, synth: 'glitch', pattern: 'X.X.X.X.X.X.X.X.' },
        { id: 'sweep',     name: 'Swish',     row: 1, synth: 'sweep', pattern: 'X...............' },
        { id: 'sidechain', name: 'Pump',      row: 1, synth: 'sidechain', pattern: 'X..X..X..X..X...' },

        /* ---- Row 2: Melodies (blue) ---- */
        { id: 'pad',       name: 'Haze',      row: 2, synth: 'pad',     pattern: 'X.....X.....X...' },
        { id: 'musicbox',  name: 'Tinker',    row: 2, synth: 'musicbox', pattern: 'X.X.X.X.X.X.X.X.', prob: 0.5, pan: 'alt' },
        { id: 'wobble',    name: 'Wubs',      row: 2, synth: 'wobble', pattern: 'X..X..X..X..X.X.' },
        { id: 'strings',   name: 'Silk',      row: 2, synth: 'strings', pattern: '....X...X...X..X', pan: 0.3 },

        /* ---- Row 3: Voices (green) ---- */
        { id: 'talkbox',   name: 'Growl',     row: 3, synth: 'talkbox',  pattern: 'X..X.X..X..X.X..' }
      ]
    },

    /* ======================================================================
       Kit 5 — Jazz (the smoky late-night crew)
       ====================================================================== */
    {
      id: 'jazz',
      name: 'Jazz',
      blurb: 'Smoky late-night crew — brushes, walking bass, and scat.',
      characters: [
        /* ---- Row 0: Beats (red) ---- */
        { id: 'ride',     name: 'Ting',     row: 0, synth: 'ride',     pattern: 'X..X.X..X.X..X.X', pan: 0.3 },
        { id: 'brushes',  name: 'Broom',    row: 0, synth: 'brushes',  pattern: '..X...X...X.X...', pan: 'alt' },
        { id: 'kick',     name: 'Thud',     row: 0, synth: 'jazzkick', pattern: 'X..X..X..X..X...' },

        /* ---- Row 1: Effects (yellow) ---- */
        { id: 'rim',      name: 'Tock',     row: 1, synth: 'rim',      pattern: '....X...X...X...' },
        { id: 'splash',   name: 'Drip',     row: 1, synth: 'splash',   pattern: 'X...............', oneShot: true },
        { id: 'wah',      name: 'Mwah',     row: 1, synth: 'wah',      pattern: 'X..X..X..X..X...' },

        /* ---- Row 2: Melodies (blue) ---- */
        { id: 'walking',  name: 'Stroll',   row: 2, synth: 'walking', pattern: 'X...X...X...X...' },
        { id: 'comp',     name: 'Chunk',    row: 2, synth: 'comp',     pattern: '..X...X...X.X...' },
        { id: 'sax',      name: 'Smoky',    row: 2, synth: 'sax',      pattern: '....X...X...X..X',
          gold: true,
          goldCombos: [
            { ids: ['ride', 'brushes', 'kick'], synth: 'saxGoldBeat' },
            { ids: ['walking', 'comp'],          synth: 'saxGoldMelody' },
            { ids: ['scat', 'hum', 'bop'],       synth: 'saxGoldVoice' }
          ] },

        /* ---- Row 3: Voices (green) ---- */
        { id: 'scat',     name: 'ShooBop', row: 3, synth: 'scat',     pattern: 'X..X..X..X..X.X.', prob: 0.5 },
        { id: 'hum',      name: 'Mmm',     row: 3, synth: 'hum',      pattern: 'X.....X.....X...' },
        { id: 'bop',      name: 'Swing',   row: 3, synth: 'bop',      pattern: 'X.X...X...X...X.' }
      ]
    },

    /* ======================================================================
       Kit 6 — RNB (smooth grooves, Rhodes, and soul)
       ====================================================================== */
    {
      id: 'rnb',
      name: 'RNB',
      blurb: 'Smooth grooves — soft beats, Rhodes, and soul.',
      characters: [
        /* ---- Row 0: Beats (red) ---- */
        { id: 'rnbkick',  name: 'Pillow',   row: 0, synth: 'rnbkick',  pattern: 'X..X..X..X..X...' },
        { id: 'rnbsnare', name: 'Velvet',   row: 0, synth: 'rnbsnare', pattern: '....X...X...X...' },
        { id: 'rnbhihat', name: 'Sizzle',   row: 0, synth: 'rnbhihat', pattern: 'X.X.X.X.X.X.X.X.', pan: 'alt' },

        /* ---- Row 1: Effects (yellow) ---- */
        { id: 'rnbRim',   name: 'Knock',    row: 1, synth: 'rnbRim',   pattern: '..X...X...X.X...' },
        { id: 'rnbshaker', name: 'Sway',    row: 1, synth: 'rnbshaker', pattern: 'X.X.X.X.X.X.X.X.',
          prob: 0.6, pan: 'alt' },
        { id: 'crackle',  name: 'Ember',    row: 1, synth: 'crackle',  pattern: 'X.gX.gX.gX.gX.gX', prob: 0.5 },

        /* ---- Row 2: Melodies (blue) ---- */
        { id: 'rhodes',   name: 'Satin',    row: 2, synth: 'rhodes',   pattern: '....X...X...X..X',
          gold: true,
          goldCombos: [
            { ids: ['rnbkick', 'rnbsnare', 'rnbhihat'], synth: 'rhodesGoldBeat' },
            { ids: ['smoothbass', 'guitar'],             synth: 'rhodesGoldMelody' },
            { ids: ['soul', 'adlib', 'rnbooh'],          synth: 'rhodesGoldVoice' }
          ] },
        { id: 'smoothbass', name: 'Honey',  row: 2, synth: 'smoothbass', pattern: 'X..X..X..X..X.X.' },
        { id: 'guitar',   name: 'Mellow',   row: 2, synth: 'guitar',   pattern: '..X...X...X.X...' },

        /* ---- Row 3: Voices (green) ---- */
        { id: 'soul',     name: 'Groove',   row: 3, synth: 'soul',     pattern: '....X.......X...', prob: 0.4 },
        { id: 'adlib',    name: 'Okay',     row: 3, synth: 'adlib',    pattern: 'X.....X.....X...' },
        { id: 'rnbooh',   name: 'Bliss',    row: 3, synth: 'rnbooh',   pattern: 'X..X..X..X..X...' }
      ]
    },

    /* ======================================================================
       Kit 7 — Salsa (the fiery Latin crew)
       ====================================================================== */
    {
      id: 'salsa',
      name: 'Salsa',
      blurb: 'Fiery Latin crew — congas, guïro, and hot brass.',
      characters: [
        /* ---- Row 0: Beats (red) ---- */
        { id: 'saconga',    name: 'Rumba',    row: 0, synth: 'saconga',    pattern: 'x...x..x...x..x.', pan: -0.3 },
        { id: 'satimbales', name: 'Ching',   row: 0, synth: 'satimbales', pattern: '....x..x...x..xf', pan: 0.3 },
        { id: 'sabongo',    name: 'Rico',    row: 0, synth: 'sabongo',    pattern: 'x.gx.gx.gx.gx.gx' },
        { id: 'saclav',     name: 'Clack',   row: 0, synth: 'saclav',     pattern: 'o..x..x...x..x..' },

        /* ---- Row 1: Effects (yellow) ---- */
        { id: 'saguiro',    name: 'Scrape',  row: 1, synth: 'saguiro',    pattern: 'x.x.x.x.x.x.x.x.',
          prob: 0.65, pan: 'alt' },
        { id: 'samaracas',  name: 'Rattle',  row: 1, synth: 'samaracas',  pattern: 'x.xx.x.xx.x.xx.x',
          prob: 0.6, pan: 'alt' },
        { id: 'sacampana',  name: 'Ding',    row: 1, synth: 'sacampana',  pattern: 'x..x..x.x..x..x.' },

        /* ---- Row 2: Melodies (blue) ---- */
        { id: 'samontuno',  name: 'Candela', row: 2, synth: 'samontuno',  pattern: 'x..x..x.x.x..x.x' },
        { id: 'satumbao',   name: 'Sabor',   row: 2, synth: 'satumbao',   pattern: 'x.....x.....x.x.' },
        { id: 'satrum',     name: 'Brass',   row: 2, synth: 'satrum',     pattern: '....x...x..x..x.',
          gold: true,
          goldCombos: [
            { ids: ['saconga', 'satimbales', 'sabongo'], synth: 'satrumGoldBeat' },
            { ids: ['samontuno', 'satumbao'],             synth: 'satrumGoldMelody' },
            { ids: ['sacoro', 'sasoneo'],                 synth: 'satrumGoldVoice' }
          ] },

        /* ---- Row 3: Voices (green) ---- */
        { id: 'sacoro',     name: 'Ole',     row: 3, synth: 'sacoro',     pattern: '....x.......x...' },
        { id: 'sasoneo',    name: 'Azucar',  row: 3, synth: 'sasoneo',    pattern: 'x..x..x...x..x..',
          prob: 0.5 }
      ]
    },

    /* ======================================================================
       Kit 8 — Bossa Nova (soft, relaxed, Brazilian)
       ====================================================================== */
    {
      id: 'bossa',
      name: 'BOSSA NOVA',
      blurb: 'Soft and cozy — warm samba swing for lazy afternoons.',
      characters: [
        /* ---- Row 0: Beats (red) ---- */
        { id: 'bossakick',   name: 'Soft',     row: 0, synth: 'bossakick',   pattern: 'X..X..X..X..X...' },
        { id: 'bossasnare',  name: 'Brush',    row: 0, synth: 'bossasnare',  pattern: '....X...X...X...' },
        { id: 'bossashaker', name: 'Samba',    row: 0, synth: 'bossashaker', pattern: 'X.X.X.X.X.X.X.X.', pan: 'alt' },
        { id: 'tamborim',    name: 'Tink',     row: 0, synth: 'tamborim',    pattern: '..X...X...X.X...' },

        /* ---- Row 1: Effects (yellow) ---- */
        { id: 'bossaguitar', name: 'Nylon',    row: 1, synth: 'bossaguitar', pattern: 'X...X...X...X...' },
        { id: 'pandeiro',    name: 'Jingle',   row: 1, synth: 'pandeiro',    pattern: 'X..X..X..X..X...' },
        { id: 'agogo',       name: 'Bell',     row: 1, synth: 'agogo',       pattern: '....X...X...X...' },

        /* ---- Row 2: Melodies (blue) ---- */
        { id: 'bossapiano',  name: 'Bossa',    row: 2, synth: 'bossapiano',  pattern: '....X...X...X..X' },
        { id: 'bossasax',    name: 'Tenor',    row: 2, synth: 'bossasax',    pattern: '....X...X...X..X' },
        { id: 'bossabass',   name: 'Upright',  row: 2, synth: 'bossabass',   pattern: 'X..X..X..X..X.X.' },

        /* ---- Row 3: Voices (green) ---- */
        { id: 'bossavoice',  name: 'Susurro',  row: 3, synth: 'bossavoice',  pattern: '....X.......X...' },
        { id: 'bossachoir',  name: 'Ahh',      row: 3, synth: 'bossachoir',  pattern: 'X.....X.....X...' }
      ]
    },

    /* ======================================================================
       Kit 9 — K-Pop (energetic, bright, heavily produced)
       ====================================================================== */
    {
      id: 'kpop',
      name: 'KPOP',
      blurb: 'Bright and catchy — polished pop with big drops.',
      characters: [
        /* ---- Row 0: Beats (red) ---- */
        { id: 'kpopkick',    name: 'Thump',    row: 0, synth: 'kpopkick',    pattern: 'X..X..X..X..X...' },
        { id: 'kpopsnare',   name: 'Snap',     row: 0, synth: 'kpopsnare',   pattern: '....X...X...X...' },
        { id: 'kophihat',    name: 'Sparkle',  row: 0, synth: 'kophihat',    pattern: 'X.X.X.X.X.X.X.X.', pan: 'alt' },
        { id: 'kpopclap',    name: 'Clap',     row: 0, synth: 'kpopclap',    pattern: '....X...X...X...' },

        /* ---- Row 1: Effects (yellow) ---- */
        { id: 'kpopriser',   name: 'Rise',     row: 1, synth: 'kpopriser',   pattern: 'X...............', oneShot: true },
        { id: 'kpopdrop',    name: 'Drop',     row: 1, synth: 'kpopdrop',    pattern: 'X...............', oneShot: true },
        { id: 'kpopsynthfx', name: 'Glitch',   row: 1, synth: 'kpopsynthfx', pattern: '..X...X...X.X...' },

        /* ---- Row 2: Melodies (blue) ---- */
        { id: 'kppsynth',    name: 'Lead',     row: 2, synth: 'kppsynth',    pattern: '....X...X...X..X' },
        { id: 'kpoppiano',   name: 'Bright',   row: 2, synth: 'kpoppiano',   pattern: 'X.X.X.X.X.X.X.X.' },
        { id: 'kpopbass',    name: 'Sub',      row: 2, synth: 'kpopbass',    pattern: 'X..X..X..X..X.X.' },

        /* ---- Row 3: Voices (green) ---- */
        { id: 'kpopvocal',   name: 'Vox',      row: 3, synth: 'kpopvocal',   pattern: '....X.......X...' },
        { id: 'kpopchant',   name: 'Hey',      row: 3, synth: 'kpopchant',   pattern: 'X.....X.....X...' }
      ]
    },

    /* ======================================================================
       Kit 10 — Trap (dark, heavy, sub-bass)
       ====================================================================== */
    {
      id: 'trap',
      name: 'TRAP',
      blurb: 'Dark and heavy — 808 sub-bass and fast hi-hats.',
      characters: [
        /* ---- Row 0: Beats (red) ---- */
        { id: '808kick',     name: '808',      row: 0, synth: '808kick',     pattern: 'X..X..X..X..X...' },
        { id: 'trapsnare',   name: 'Roll',     row: 0, synth: 'trapsnare',   pattern: '....X...X...X...' },
        { id: 'traphihat',   name: 'Tsk',      row: 0, synth: 'traphihat',   pattern: 'X.X.X.X.X.X.X.X.', pan: 'alt' },
        { id: 'trapclap',    name: 'Slap',     row: 0, synth: 'trapclap',    pattern: '....X...X...X...' },

        /* ---- Row 1: Effects (yellow) ---- */
        { id: 'traproll',    name: 'Roll',     row: 1, synth: 'traproll',    pattern: '..X...X...X.X...' },
        { id: 'trapriser',   name: 'Dark',     row: 1, synth: 'trapriser',   pattern: 'X...............', oneShot: true },
        { id: 'trapfx',      name: 'Urban',    row: 1, synth: 'trapfx',      pattern: 'X...............' },

        /* ---- Row 2: Melodies (blue) ---- */
        { id: 'trapsynth',   name: 'Dark',     row: 2, synth: 'trapsynth',   pattern: '....X...X...X..X' },
        { id: 'trappiano',   name: 'Minor',    row: 2, synth: 'trappiano',   pattern: 'X..X..X..X..X...' },
        { id: 'trapbass',    name: 'Slide',    row: 2, synth: 'trapbass',    pattern: 'X..X..X..X..X.X.' },

        /* ---- Row 3: Voices (green) ---- */
        { id: 'trapvocal',   name: 'Adlib',    row: 3, synth: 'trapvocal',   pattern: '....X.......X...' }
      ]
    },

    /* ======================================================================
       Kit 11 — Lo-Fi (relaxed, nostalgic, study vibes)
       ====================================================================== */
    {
      id: 'lofi',
      name: 'LOFI',
      blurb: 'Mellow and nostalgic — dusty beats for studying.',
      characters: [
        /* ---- Row 0: Beats (red) ---- */
        { id: 'lofikick',    name: 'Soft',     row: 0, synth: 'lofikick',    pattern: 'X..X..X..X..X...' },
        { id: 'lofisnare',   name: 'Dusty',    row: 0, synth: 'lofisnare',   pattern: '....X...X...X...' },
        { id: 'lofihihat',   name: 'Hiss',     row: 0, synth: 'lofihihat',   pattern: 'X.X.X.X.X.X.X.X.', pan: 'alt' },
        { id: 'loficrackle', name: 'Vinyl',    row: 0, synth: 'loficrackle', pattern: 'X.X.X.X.X.X.X.X.', prob: 0.5 },

        /* ---- Row 1: Effects (yellow) ---- */
        { id: 'lofirain',    name: 'Rain',     row: 1, synth: 'lofirain',    pattern: 'X.X.X.X.X.X.X.X.' },
        { id: 'lofitape',    name: 'Tape',     row: 1, synth: 'lofitape',    pattern: 'X.X.X.X.X.X.X.X.' },
        { id: 'lofipop',     name: 'Pop',      row: 1, synth: 'lofipop',     pattern: 'X...............', oneShot: true },

        /* ---- Row 2: Melodies (blue) ---- */
        { id: 'lofipiano',   name: 'Mellow',   row: 2, synth: 'lofipiano',   pattern: '....X...X...X..X' },
        { id: 'lofiguitar',  name: 'Nostalgia', row: 2, synth: 'lofiguitar', pattern: 'X..X..X..X..X...' },
        { id: 'lofibass',    name: 'Round',    row: 2, synth: 'lofibass',    pattern: 'X..X..X..X..X.X.' },

        /* ---- Row 3: Voices (green) ---- */
        { id: 'lofivocal',   name: 'Ahh',      row: 3, synth: 'lofivocal',   pattern: '....X.......X...' }
      ]
    }
  ]
};
