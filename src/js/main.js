/* ==========================================================================
   Play Musik — main.js
   UI wiring: kit selector, 4x3 character grid, transport controls, row
   mute/volume, step indicator, settings modal, and localStorage persistence.

   Classic scripts loaded in order (data.js -> audio-engine.js -> main.js),
   so the app also works from file:// with no server at all.
   ========================================================================== */

'use strict';

(function () {
  var data = PlayMusikData;
  var audio = PlayMusikAudio;
  var i18n = PlayMusikI18n;

  var STORAGE_KEY = 'musiclike-state-v2';

  // DOM refs
  var kitBar = document.getElementById('kit-bar');
  var gridEl = document.getElementById('grid');
  var playBtn = document.getElementById('play-btn');
  var bpmSlider = document.getElementById('bpm-slider');
  var bpmValue = document.getElementById('bpm-value');
  var stepIndicator = document.getElementById('step-indicator');
  var randomBtn = document.getElementById('random-btn');
  var settingsBtn = document.getElementById('settings-btn');
  var creditsBtn = document.getElementById('credits-btn');
  var langBtn = document.getElementById('lang-btn');
  var settingsModal = document.getElementById('settings-modal');
  var settingsClose = document.getElementById('settings-close');
  var settingsMenu = document.getElementById('settings-menu');
  var creditsEntry = document.getElementById('credits-entry');
  var languageEntry = document.getElementById('language-entry');
  var creditsPanel = document.getElementById('credits-panel');
  var languagePanel = document.getElementById('language-panel');
  var creditsBack = document.getElementById('credits-back');
  var languageBack = document.getElementById('language-back');
  var langButtons = document.querySelectorAll('.lang-btn');
  var timeSigButtons = document.querySelectorAll('.time-sig button');
  var homePanel = document.getElementById('home-panel');
  var homeStart = document.getElementById('home-start');
  var transportEl = document.querySelector('.transport');

  // Runtime state
  var state = {
    currentKit: data.kits[0].id,
    activeByKit: {}, // kitId -> { charId: true }
    probOn: {},      // charId -> true (probability gate enabled)
    bpm: data.bpm,
    timeSignature: '4/4',
    rows: [
      { muted: false, volume: 80 },
      { muted: false, volume: 80 },
      { muted: false, volume: 80 },
      { muted: false, volume: 80 }
    ]
  };

  var kitPills = {};   // kitId -> pill button
  var homePill = null; // the Home pill (first in the bar)
  var rowEls = [];     // section per row
  var charEls = {};    // charId -> button element
  var stepDots = [];

  /* ------------------------- helpers ------------------------------------- */

  function currentKit() {
    for (var i = 0; i < data.kits.length; i++) {
      if (data.kits[i].id === state.currentKit) {
        return data.kits[i];
      }
    }
    return data.kits[0];
  }

  function charById(id) {
    var chars = currentKit().characters;
    for (var i = 0; i < chars.length; i++) {
      if (chars[i].id === id) {
        return chars[i];
      }
    }
    return null;
  }

  function activeSet() {
    if (!state.activeByKit[state.currentKit]) {
      state.activeByKit[state.currentKit] = {};
    }
    return state.activeByKit[state.currentKit];
  }

  /* ------------------------- inline SVG icons ---------------------------- */
  /* Every character gets a hand-drawn path set (fill:none, currentColor).  */

  var ICONS = {
    kick: '<circle cx="24" cy="24" r="10"/><path d="M24 4v8M24 36v8M4 24h8M36 24h8"/>',
    snare: '<circle cx="24" cy="24" r="12"/><path d="M24 15v18M15 24h18"/>',
    hihat: '<path d="M8 18h32M8 30h32M24 30v10"/>',
    scratch: '<path d="M8 32L16 16l8 16 8-16 8 16"/><circle cx="40" cy="36" r="4"/>',
    boom: '<path d="M24 6l4 12 12 4-12 4-4 12-4-12-12-4 12-4z"/>',
    zap: '<path d="M26 4L10 28h10l-4 16 18-24H24z"/>',
    bass: '<path d="M6 30c6-8 12-8 18 0s12 8 18 0M6 40c6-8 12-8 18 0s12 8 18 0"/>',
    lead: '<path d="M22 34V12l16-4v22"/><circle cx="17" cy="34" r="5"/><circle cx="33" cy="30" r="5"/>',
    arp: '<path d="M24 8l3 9 9 3-9 3-3 9-3-9-9-3 9-3z"/><circle cx="38" cy="12" r="2"/><circle cx="10" cy="38" r="2"/>',
    chant: '<circle cx="22" cy="14" r="6"/><path d="M10 40c2-10 8-14 12-14s10 4 12 14"/><path d="M32 18c3 2 3 6 0 8"/>',
    beatbox: '<rect x="20" y="6" width="8" height="20" rx="4"/><path d="M14 24a10 10 0 0 0 20 0M24 34v8M18 42h12"/>',
    ooh: '<ellipse cx="24" cy="24" rx="10" ry="14"/><ellipse cx="24" cy="24" rx="4" ry="8"/>',

    /* ---- Kit 2: Neon ---- */
    toms: '<circle cx="13" cy="32" r="6"/><circle cx="24" cy="24" r="8"/><circle cx="36" cy="17" r="10"/>',
    clap: '<rect x="8" y="12" width="12" height="24" rx="6" transform="rotate(-15 14 24)"/><rect x="28" y="12" width="12" height="24" rx="6" transform="rotate(15 34 24)"/><path d="M24 18v5M24 27v4"/>',
    shaker: '<ellipse cx="24" cy="27" rx="8" ry="14"/><path d="M24 13v-5M18 11l-3-3M30 11l3-3"/><path d="M16 30h16"/>',
    airhorn: '<path d="M8 20h6l10-8v24l-10-8H8z"/><path d="M30 18c4 3 4 9 0 12"/><path d="M37 14c5 4 5 16 0 20"/>',
    vinyl: '<circle cx="24" cy="24" r="16"/><circle cx="24" cy="24" r="11"/><circle cx="24" cy="24" r="6"/><path d="M24 8v5M24 35v5M8 24h5M35 24h5"/>',
    riser: '<path d="M8 40h32M12 40V29M20 40V20M28 40V13M36 40V8"/>',
    piano: '<rect x="8" y="16" width="32" height="18" rx="2"/><path d="M16 16v10M24 16v10M32 16v10"/><path d="M12 16v8M20 16v8M28 16v8M36 16v8"/>',
    pluck: '<path d="M24 6v36"/><path d="M24 10c-6 2-6 6 0 8M24 20c-6 2-6 6 0 8M24 30c-6 2-6 6 0 8"/>',
    chiptune: '<rect x="6" y="18" width="36" height="14" rx="7"/><path d="M14 21v8M10 25h8"/><circle cx="32" cy="22" r="1.6"/><circle cx="36" cy="26" r="1.6"/>',
    hey: '<path d="M8 14h32v18H22l-8 8v-8H8z"/><path d="M24 18v6M24 28v2"/>',
    yeah: '<rect x="8" y="24" width="8" height="16" rx="4"/><path d="M16 26l8-8c2-2 5-1 5 2l-2 6h11c2 0 3 2 2 4l-4 10H16"/>',
    whistle: '<circle cx="20" cy="30" r="9"/><path d="M29 30h7c3 0 3-8 0-8h-5l-3-6h-4"/>',

    /* ---- Kit 3: World ---- */
    congas: '<rect x="10" y="16" width="10" height="20" rx="3"/><rect x="28" y="12" width="10" height="24" rx="3"/><path d="M10 16h10M28 12h10"/>',
    cowbell: '<path d="M16 10h16l-3 26h-10z"/><path d="M16 10c-2 8-2 18 0 26M32 10c2 8 2 18 0 26"/>',
    tambourine: '<circle cx="24" cy="24" r="14"/><circle cx="24" cy="24" r="9"/><path d="M12 18l3 2M12 30l3-2M36 18l-3 2M36 30l-3-2"/>',
    panflute: '<rect x="8" y="12" width="6" height="26" rx="2"/><rect x="16" y="8" width="6" height="30" rx="2"/><rect x="24" y="14" width="6" height="24" rx="2"/><rect x="32" y="10" width="6" height="28" rx="2"/>',
    choir: '<circle cx="12" cy="16" r="5"/><circle cx="24" cy="14" r="5"/><circle cx="36" cy="16" r="5"/><path d="M4 34c2-6 5-8 8-8s6 2 8 8M16 32c2-6 5-8 8-8s6 2 8 8M28 34c2-6 5-8 8-8s6 2 8 8"/>',
    opera: '<circle cx="24" cy="16" r="7"/><path d="M12 40c2-10 8-14 12-14s10 4 12 14"/><path d="M17 12l2-4 2 4 2-4 2 4 2-4 2 4"/>',
    djembe: '<path d="M14 8h20c1 6 2 12 0 16H14c-2-4-1-10 0-16z"/><path d="M14 24h20l-4 18H18z"/><ellipse cx="24" cy="8" rx="10" ry="3"/>',
    rainstick: '<path d="M10 8h28l-4 32H14z"/><path d="M16 14l3 2M24 14l3 2M32 14l3 2M14 22l3 2M22 22l3 2M30 22l3 2M18 30l3 2M26 30l3 2"/>',

    /* ---- Kit 4: Circuit ---- */
    sub808: '<circle cx="24" cy="24" r="14"/><circle cx="24" cy="24" r="6"/><path d="M24 4v6M24 38v6M4 24h6M38 24h6"/>',
    crash: '<ellipse cx="24" cy="20" rx="16" ry="6"/><path d="M24 20v16"/><path d="M8 20c-2 6 2 10 6 12M40 20c2 6-2 10-6 12"/><path d="M14 8l2 3M34 8l-2 3"/>',
    rimshot: '<circle cx="24" cy="24" r="15"/><path d="M24 9v30M9 24h30"/><path d="M37 7l4 4"/>',
    glitch: '<rect x="6" y="10" width="12" height="8"/><rect x="22" y="6" width="10" height="8"/><rect x="10" y="22" width="14" height="8"/><rect x="30" y="20" width="12" height="8"/><rect x="16" y="34" width="10" height="8"/><rect x="30" y="34" width="8" height="8"/>',
    sweep: '<path d="M6 36c8-2 10-12 18-12s10 10 18 8"/><path d="M36 26l6 6 6-6"/>',
    sidechain: '<path d="M6 20h6v8h6v-12h6v16h6v-8h6"/>',
    pad: '<rect x="10" y="10" width="28" height="28" rx="8"/><path d="M16 24c2-3 4-3 6 0s4 3 6 0 4-3 6 0"/>',
    musicbox: '<rect x="8" y="18" width="32" height="18" rx="3"/><path d="M20 30V20l10-3v10"/><circle cx="17" cy="30" r="3"/><circle cx="27" cy="27" r="3"/>',
    wobble: '<path d="M6 30c4-8 8-8 12 0s8 8 12 0 8-8 12 0"/><path d="M6 38c4-8 8-8 12 0s8 8 12 0 8-8 12 0"/>',
    strings: '<path d="M12 8v32M24 8v32M36 8v32"/><path d="M8 20c6-4 10-4 16 0s10 4 16 0"/>',
    talkbox: '<circle cx="20" cy="15" r="6"/><path d="M10 40c2-10 8-14 12-14s10 4 12 14"/><path d="M31 12l3 3-3 3"/><path d="M35 8l3 3-3 3"/>',

    /* ---- Kit 5: Jazz ---- */
    ride: '<path d="M8 18c4-6 8-8 16-8s12 2 16 8"/><path d="M24 10v6"/><circle cx="24" cy="20" r="3"/><path d="M24 23v15M18 38h12"/>',
    brushes: '<path d="M12 6v22"/><path d="M12 28c-4 2-6 6-6 12h12c0-6-2-10-6-12"/><path d="M12 6h6M12 12h6M12 18h6"/>',
    rim: '<circle cx="24" cy="24" r="14"/><circle cx="24" cy="24" r="10"/><path d="M24 10v4M24 34v4M10 24h4M34 24h4"/>',
    splash: '<ellipse cx="24" cy="18" rx="14" ry="4"/><path d="M24 18v16"/><path d="M10 18c-2 6 2 10 6 12M38 18c2 6-2 10-6 12"/><path d="M14 8l2 3M34 8l-2 3"/>',
    wah: '<path d="M6 30h8l12-10v20l-12-10H6z"/><path d="M26 30h8c4 0 6-3 6-6"/>',
    walking: '<path d="M10 6v36"/><path d="M10 10c-5 2-5 6 0 8M10 20c-5 2-5 6 0 8M10 30c-5 2-5 6 0 8"/><path d="M30 6v36"/><path d="M30 10c5 2 5 6 0 8M30 20c5 2 5 6 0 8M30 30c5 2 5 6 0 8"/>',
    comp: '<rect x="6" y="20" width="36" height="16" rx="2"/><path d="M14 20v8M22 20v8M30 20v8"/><path d="M10 20v6M18 20v6M26 20v6M34 20v6"/><path d="M14 36v4M22 36v4M30 36v4"/>',
    sax: '<path d="M20 4h5v10"/><path d="M25 14c0 8-5 12-12 12"/><path d="M13 26c-5 0-7 3-7 7 0 6 7 9 14 9s14-3 14-9c0-4-2-7-7-7"/><path d="M25 8h4M25 12h4"/>',
    scat: '<circle cx="20" cy="16" r="6"/><path d="M10 40c2-8 7-12 10-12s8 4 10 12"/><circle cx="34" cy="12" r="3"/><circle cx="38" cy="20" r="2"/>',
    hum: '<circle cx="20" cy="16" r="6"/><path d="M10 40c2-8 7-12 10-12s8 4 10 12"/><path d="M14 30h12"/><path d="M32 12c3 2 3 6 0 8M36 16c2 2 2 5 0 7"/>',
    bop: '<ellipse cx="24" cy="26" rx="9" ry="7"/><path d="M24 19v14"/><path d="M15 26h18"/><path d="M34 10l2 4 4 2-4 2-2 4-2-4-4-2 4-2z"/>',

    /* ---- Kit 6: RNB ---- */
    rnbkick: '<circle cx="24" cy="24" r="11"/><path d="M24 6v6M24 36v6M6 24h6M36 24h6"/><path d="M24 13c6 0 11 5 11 11"/>',
    rnbsnare: '<circle cx="24" cy="24" r="13"/><path d="M24 11v26M11 24h26"/><path d="M24 24l8-8"/>',
    rnbhihat: '<path d="M6 20h36M6 28h36M24 28v12"/><path d="M24 20v-6"/>',
    rnbRim: '<circle cx="24" cy="24" r="15"/><circle cx="24" cy="24" r="11"/><path d="M24 9v6M24 33v6M9 24h6M33 24h6"/>',
    rnbshaker: '<ellipse cx="24" cy="26" rx="7" ry="13"/><path d="M24 13v-5M18 11l-3-3M30 11l3-3"/><path d="M17 30h14"/>',
    crackle: '<path d="M8 30c3-6 6-6 9 0s6 6 9 0 6-6 9 0"/><path d="M8 38c3-6 6-6 9 0s6 6 9 0 6-6 9 0"/><path d="M14 8l2 3M34 8l-2 3"/>',
    rhodes: '<rect x="6" y="18" width="36" height="16" rx="2"/><path d="M14 18v8M22 18v8M30 18v8"/><path d="M10 18v6M18 18v6M26 18v6M34 18v6"/><path d="M14 34v4M22 34v4M30 34v4"/>',
    smoothbass: '<path d="M8 30c5-8 10-8 15 0s10 8 15 0"/><path d="M8 40c5-8 10-8 15 0s10 8 15 0"/><path d="M24 6v10"/>',
    guitar: '<path d="M24 6v36"/><path d="M24 10c-6 2-6 6 0 8M24 20c-6 2-6 6 0 8M24 30c-6 2-6 6 0 8"/><path d="M24 6h6"/>',
    soul: '<circle cx="22" cy="15" r="6"/><path d="M10 40c2-10 8-14 12-14s10 4 12 14"/><path d="M32 19c3 2 3 6 0 8"/><path d="M14 30h16"/>',
    adlib: '<path d="M8 14h32v18H22l-8 8v-8H8z"/><path d="M24 18v6M24 28v2"/><path d="M32 18l4 4-4 4"/>',
    rnbooh: '<ellipse cx="24" cy="24" rx="10" ry="14"/><ellipse cx="24" cy="24" rx="4" ry="8"/><path d="M24 10v-4"/>',

    /* ---- Kit 7: Salsa ---- */
    saconga: '<path d="M9 16h12l-1.5 22H10.5z"/><path d="M27 12h12l-1.5 26h-9z"/><ellipse cx="15" cy="15" rx="6" ry="2"/><ellipse cx="33" cy="11" rx="6" ry="2"/>',
    satimbales: '<circle cx="14" cy="20" r="7"/><circle cx="34" cy="20" r="7"/><path d="M7 20h14M27 20h14"/><path d="M14 27v9M34 27v9"/><path d="M14 36h20"/>',
    sabongo: '<ellipse cx="15" cy="17" rx="7" ry="3"/><path d="M8 17v8c0 3 5 4 7 4s7-1 7-4v-8"/><ellipse cx="33" cy="21" rx="6" ry="2.5"/><path d="M27 21v6c0 2.5 4 3.2 6 3.2s6-.7 6-3.2v-6"/><path d="M15 29v7M33 30.2v5.8"/>',
    saclav: '<rect x="7" y="10" width="8" height="28" rx="4" transform="rotate(25 11 24)"/><rect x="33" y="10" width="8" height="28" rx="4" transform="rotate(-25 37 24)"/>',
    saguiro: '<path d="M10 26c0-10 5-18 14-18s14 8 14 18-5 18-14 18-14-8-14-18z"/><path d="M12 20h4M12 26h4M12 32h4M32 20h4M32 26h4M32 32h4"/><path d="M20 8l-7 32"/>',
    samaracas: '<ellipse cx="13" cy="16" rx="5" ry="8"/><path d="M13 24v12"/><ellipse cx="35" cy="14" rx="5" ry="8"/><path d="M35 22v14"/><path d="M6 10l4 3M20 10l-4 3M28 8l4 3M42 8l-4 3"/>',
    sacampana: '<path d="M16 8h16l2 12c2 6-4 12-10 12s-12-6-10-12z"/><path d="M14 36c0 3 4 5 10 5s10-2 10-5"/>',
    samontuno: '<rect x="6" y="18" width="36" height="16" rx="2"/><path d="M14 18v8M22 18v8M30 18v8"/><path d="M10 18v6M18 18v6M26 18v6M34 18v6"/><path d="M16 34v4M24 34v4M32 34v4"/><circle cx="14" cy="8" r="2"/><circle cx="20" cy="6" r="2"/><circle cx="26" cy="8" r="2"/>',
    satumbao: '<rect x="21" y="6" width="6" height="22" rx="3"/><path d="M12 40c4-8 26-8 30 0-3 4-9 6-15 6s-12-2-15-6z"/><path d="M21 11h6M21 16h6M21 21h6"/>',
    satrum: '<path d="M6 24h18"/><path d="M24 24l8-8v16l-8-8z"/><path d="M12 18v12M18 18v12"/><circle cx="12" cy="24" r="2"/><circle cx="18" cy="24" r="2"/>',
    sacoro: '<circle cx="13" cy="15" r="5"/><path d="M5 34c2-6 5-8 8-8s6 2 8 8"/><ellipse cx="13" cy="20" rx="2" ry="2.5"/><circle cx="30" cy="15" r="5"/><path d="M22 34c2-6 5-8 8-8s6 2 8 8"/><ellipse cx="30" cy="20" rx="2" ry="2.5"/><path d="M40 6v9"/><circle cx="40" cy="17" r="2.6"/>',
    sasoneo: '<circle cx="20" cy="15" r="6"/><path d="M10 40c2-10 8-14 12-14s10 4 12 14"/><ellipse cx="20" cy="21" rx="2.4" ry="3"/><path d="M35 10v8"/><circle cx="35" cy="20" r="3"/><path d="M35 23v7"/>',

    /* ---- Kit 8: Bossa Nova ---- */
    bossakick: '<circle cx="24" cy="24" r="10"/><path d="M24 4v8M24 36v8M4 24h8M36 24h8"/>',
    bossasnare: '<circle cx="24" cy="24" r="12"/><path d="M24 15v18M15 24h18"/>',
    bossashaker: '<ellipse cx="24" cy="27" rx="8" ry="14"/><path d="M24 13v-5M18 11l-3-3M30 11l3-3"/><path d="M16 30h16"/>',
    tamborim: '<circle cx="24" cy="24" r="14"/><path d="M24 10v28M10 24h28"/>',
    bossaguitar: '<path d="M24 6v36"/><path d="M24 10c-6 2-6 6 0 8M24 20c-6 2-6 6 0 8M24 30c-6 2-6 6 0 8"/><path d="M24 6h6"/>',
    pandeiro: '<circle cx="24" cy="24" r="14"/><circle cx="24" cy="24" r="9"/><path d="M12 18l3 2M12 30l3-2M36 18l-3 2M36 30l-3-2"/>',
    agogo: '<path d="M16 10h16l-3 26h-10z"/><path d="M16 10c-2 8-2 18 0 26M32 10c2 8 2 18 0 26"/>',
    bossapiano: '<rect x="8" y="16" width="32" height="18" rx="2"/><path d="M16 16v10M24 16v10M32 16v10"/><path d="M12 16v8M20 16v8M28 16v8M36 16v8"/>',
    bossasax: '<path d="M20 4h5v10"/><path d="M25 14c0 8-5 12-12 12"/><path d="M13 26c-5 0-7 3-7 7 0 6 7 9 14 9s14-3 14-9c0-4-2-7-7-7"/><path d="M25 8h4M25 12h4"/>',
    bossabass: '<path d="M10 6v36"/><path d="M10 10c-5 2-5 6 0 8M10 20c-5 2-5 6 0 8M10 30c-5 2-5 6 0 8"/><path d="M30 6v36"/><path d="M30 10c5 2 5 6 0 8M30 20c5 2 5 6 0 8M30 30c5 2 5 6 0 8"/>',
    bossavoice: '<circle cx="22" cy="15" r="6"/><path d="M10 40c2-10 8-14 12-14s10 4 12 14"/><path d="M32 19c3 2 3 6 0 8"/>',
    bossachoir: '<circle cx="12" cy="16" r="5"/><circle cx="24" cy="14" r="5"/><circle cx="36" cy="16" r="5"/><path d="M4 34c2-6 5-8 8-8s6 2 8 8M16 32c2-6 5-8 8-8s6 2 8 8M28 34c2-6 5-8 8-8s6 2 8 8"/>',

    /* ---- Kit 9: K-Pop ---- */
    kpopkick: '<circle cx="24" cy="24" r="11"/><path d="M24 6v6M24 36v6M6 24h6M36 24h6"/><path d="M24 13c6 0 11 5 11 11"/>',
    kpopsnare: '<circle cx="24" cy="24" r="13"/><path d="M24 11v26M11 24h26"/><path d="M24 24l8-8"/>',
    kophihat: '<path d="M6 20h36M6 28h36M24 28v12"/><path d="M24 20v-6"/>',
    kpopclap: '<rect x="8" y="12" width="12" height="24" rx="6" transform="rotate(-15 14 24)"/><rect x="28" y="12" width="12" height="24" rx="6" transform="rotate(15 34 24)"/><path d="M24 18v5M24 27v4"/>',
    kpopriser: '<path d="M8 40h32M12 40V29M20 40V20M28 40V13M36 40V8"/>',
    kpopdrop: '<path d="M24 4v8M24 36v8M4 24h8M36 24h8"/><circle cx="24" cy="24" r="10"/>',
    kpopsynthfx: '<rect x="6" y="10" width="12" height="8"/><rect x="22" y="6" width="10" height="8"/><rect x="30" y="20" width="12" height="8"/><rect x="16" y="34" width="10" height="8"/>',
    kppsynth: '<path d="M22 34V12l16-4v22"/><circle cx="17" cy="34" r="5"/><circle cx="33" cy="30" r="5"/>',
    kpoppiano: '<rect x="6" y="18" width="36" height="16" rx="2"/><path d="M14 18v8M22 18v8M30 18v8"/><path d="M10 18v6M18 18v6M26 18v6M34 18v6"/><path d="M14 34v4M22 34v4M30 34v4"/>',
    kpopbass: '<path d="M8 30c5-8 10-8 15 0s10 8 15 0"/><path d="M8 40c5-8 10-8 15 0s10 8 15 0"/><path d="M24 6v10"/>',
    kpopvocal: '<circle cx="22" cy="15" r="6"/><path d="M10 40c2-10 8-14 12-14s10 4 12 14"/><path d="M32 19c3 2 3 6 0 8"/><path d="M14 30h16"/>',
    kpopchant: '<path d="M8 14h32v18H22l-8 8v-8H8z"/><path d="M24 18v6M24 28v2"/><path d="M32 18l4 4-4 4"/>',

    /* ---- Kit 10: Trap ---- */
    '808kick': '<circle cx="24" cy="24" r="14"/><circle cx="24" cy="24" r="6"/><path d="M24 4v6M24 38v6M4 24h6M38 24h6"/>',
    trapsnare: '<circle cx="24" cy="24" r="15"/><path d="M24 9v30M9 24h30"/><path d="M37 7l4 4"/>',
    traphihat: '<path d="M8 18h32M8 30h32M24 30v10"/>',
    trapclap: '<rect x="8" y="12" width="12" height="24" rx="6" transform="rotate(-15 14 24)"/><rect x="28" y="12" width="12" height="24" rx="6" transform="rotate(15 34 24)"/><path d="M24 18v5M24 27v4"/>',
    traproll: '<path d="M6 20h36M6 28h36M24 28v12"/><path d="M24 20v-6"/><path d="M12 20v-4M36 20v-4"/>',
    trapriser: '<path d="M8 40h32M12 40V29M20 40V20M28 40V13M36 40V8"/>',
    trapfx: '<path d="M6 36c8-2 10-12 18-12s10 10 18 8"/><path d="M36 26l6 6 6-6"/>',
    trapsynth: '<path d="M6 30c4-8 8-8 12 0s8 8 12 0 8-8 12 0"/><path d="M6 38c4-8 8-8 12 0s8 8 12 0 8-8 12 0"/>',
    trappiano: '<rect x="8" y="16" width="32" height="18" rx="2"/><path d="M16 16v10M24 16v10M32 16v10"/><path d="M12 16v8M20 16v8M28 16v8M36 16v8"/>',
    trapbass: '<path d="M6 30c6-8 12-8 18 0s12 8 18 0M6 40c6-8 12-8 18 0s12 8 18 0"/>',
    trapvocal: '<circle cx="20" cy="15" r="6"/><path d="M10 40c2-10 8-14 12-14s10 4 12 14"/><ellipse cx="20" cy="21" rx="2.4" ry="3"/><path d="M35 10v8"/><circle cx="35" cy="20" r="3"/><path d="M35 23v7"/>',

    /* ---- Kit 11: Lo-Fi ---- */
    lofikick: '<circle cx="24" cy="24" r="10"/><path d="M24 4v8M24 36v8M4 24h8M36 24h8"/>',
    lofisnare: '<circle cx="24" cy="24" r="12"/><path d="M24 15v18M15 24h18"/>',
    lofihihat: '<path d="M8 18h32M8 30h32M24 30v10"/>',
    loficrackle: '<path d="M8 30c3-6 6-6 9 0s6 6 9 0 6-6 9 0"/><path d="M8 38c3-6 6-6 9 0s6 6 9 0 6-6 9 0"/><path d="M14 8l2 3M34 8l-2 3"/>',
    lofirain: '<path d="M8 12v24M16 8v28M24 12v24M32 8v28M40 12v24"/><path d="M4 20h8M12 16h8M20 20h8M28 16h8M36 20h8"/>',
    lofitape: '<rect x="6" y="14" width="36" height="20" rx="3"/><circle cx="16" cy="24" r="5"/><circle cx="32" cy="24" r="5"/><path d="M16 24h16"/>',
    lofipop: '<circle cx="24" cy="24" r="10"/><path d="M24 14v20M14 24h20"/>',
    lofipiano: '<rect x="8" y="16" width="32" height="18" rx="2"/><path d="M16 16v10M24 16v10M32 16v10"/><path d="M12 16v8M20 16v8M28 16v8M36 16v8"/>',
    lofiguitar: '<path d="M24 6v36"/><path d="M24 10c-6 2-6 6 0 8M24 20c-6 2-6 6 0 8M24 30c-6 2-6 6 0 8"/><path d="M24 6h6"/>',
    lofibass: '<path d="M8 30c5-8 10-8 15 0s10 8 15 0"/><path d="M8 40c5-8 10-8 15 0s10 8 15 0"/><path d="M24 6v10"/>',
    lofivocal: '<circle cx="22" cy="15" r="6"/><path d="M10 40c2-10 8-14 12-14s10 4 12 14"/><path d="M32 19c3 2 3 6 0 8"/>'
  };

  function iconSvg(paths) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 48 48');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '4');
    svg.setAttribute('stroke-linecap', 'square');
    svg.setAttribute('stroke-linejoin', 'miter');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = paths;
    return svg;
  }

  function speakerSvg(withSlash) {
    var paths =
      '<path d="M6 18v12h8l10 8V10L14 18z"/><path d="M32 18c4 4 4 8 0 12M36 14c6 5 6 15 0 20"/>';
    if (withSlash) {
      paths += '<path d="M36 14L22 22M22 14L36 22"/>';
    }
    return iconSvg(paths);
  }

  /* ------------------------- kit selector -------------------------------- */

  function buildKitBar() {
    // Home pill — sits at the far left, before Origin. Shows the software
    // presentation panel instead of a kit.
    homePill = document.createElement('button');
    homePill.type = 'button';
    homePill.className = 'kit-pill home-pill';
    homePill.setAttribute('role', 'tab');
    homePill.setAttribute('aria-selected', 'false');
    homePill.title = i18n.t('home.title');

    var homeName = document.createElement('span');
    homeName.className = 'kit-pill-name';
    homeName.textContent = i18n.t('home');
    homePill.appendChild(homeName);

    homePill.addEventListener('click', function () {
      toggleHome();
    });

    kitBar.appendChild(homePill);

    data.kits.forEach(function (kit) {
      var pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'kit-pill';
      pill.dataset.kit = kit.id;
      pill.setAttribute('role', 'tab');
      pill.setAttribute('aria-selected', kit.id === state.currentKit ? 'true' : 'false');
      pill.title = kit.blurb || kit.name;

      var name = document.createElement('span');
      name.className = 'kit-pill-name';
      name.textContent = kit.name;
      pill.appendChild(name);

      pill.addEventListener('click', function () {
        switchKit(kit.id);
      });

      kitBar.appendChild(pill);
      kitPills[kit.id] = pill;
    });
  }

  // Show the Home presentation panel (its own section, grid hidden).
  function showHome() {
    if (homePanel) {
      homePanel.hidden = false;
    }
    if (gridEl) {
      gridEl.hidden = true;
    }
    // Home is a pure landing screen: hide the musical transport controls
    // (play/BPM/time-sig/random) so nothing musical shows below it. The
    // Settings button stays so the language can still be switched.
    if (transportEl) {
      transportEl.classList.add('home-active');
    }
    if (homePill) {
      homePill.classList.add('active');
      homePill.setAttribute('aria-selected', 'true');
    }
    // De-select every kit pill.
    Object.keys(kitPills).forEach(function (id) {
      kitPills[id].classList.remove('active');
      kitPills[id].setAttribute('aria-selected', 'false');
    });
  }

  // Hide the Home panel and show the character grid.
  function hideHome() {
    if (homePanel) {
      homePanel.hidden = true;
    }
    if (gridEl) {
      gridEl.hidden = false;
    }
    if (transportEl) {
      transportEl.classList.remove('home-active');
    }
    if (homePill) {
      homePill.classList.remove('active');
      homePill.setAttribute('aria-selected', 'false');
    }
  }

  // Toggle the Home panel open/closed.
  function toggleHome() {
    if (homePanel && homePanel.hidden) {
      showHome();
    } else {
      hideHome();
    }
  }

  function switchKit(kitId) {
    hideHome(); // leaving the Home screen to build a beat

    if (kitId !== state.currentKit) {
      state.currentKit = kitId;
      audio.setKit(kitId);

      // Rebuild the grid for the new kit.
      gridEl.replaceChildren();
      rowEls = [];
      charEls = {};
      buildGrid();
      applyProbBadges();

      // Re-arm the characters that were active in this kit.
      var saved = state.activeByKit[kitId] || {};
      Object.keys(saved).forEach(function (id) {
        var ch = charById(id);
        if (ch && !ch.oneShot) {
          setCharActive(id, true);
          audio.setActive(id, true);
        }
      });
    }

    // Reflect the selection on the pills (always, even if the kit was already
    // current — e.g. leaving the Home screen for the default kit).
    Object.keys(kitPills).forEach(function (id) {
      var on = id === kitId;
      kitPills[id].classList.toggle('active', on);
      kitPills[id].setAttribute('aria-selected', on ? 'true' : 'false');
    });

    // Keep the active pill in view inside the horizontally scrollable bar.
    kitPills[kitId].scrollIntoView({ inline: 'nearest', block: 'nearest' });

    save();
  }

  /* ------------------------- grid construction ---------------------------- */

  // Full tooltip for a character card, localized (name stays as-is).
  function charTitle(ch) {
    if (ch.oneShot) {
      return ch.name + ' — ' + i18n.t('char.oneShot');
    }
    if (ch.ghostOf) {
      var ghost = charById(ch.ghostOf) || {};
      return ch.name + ' — ' + i18n.t('char.ghost', { name: ghost.name });
    }
    return ch.name + ' — ' + i18n.t('char.toggle');
  }

  function buildCharCard(ch) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'char';
    btn.dataset.id = ch.id;
    btn.title = charTitle(ch);
    btn.setAttribute('aria-pressed', 'false');

    if (ch.oneShot) {
      btn.classList.add('one-shot');
      btn.title = charTitle(ch);
    }

    if (ch.gold) {
      btn.classList.add('gold');
      var star = document.createElement('span');
      star.className = 'gold-badge';
      star.textContent = '★';
      star.setAttribute('aria-hidden', 'true');
      btn.appendChild(star);
    }

    if (ch.ghostOf) {
      btn.classList.add('ghost');
      btn.title = charTitle(ch);
    }

    var icon = iconSvg(ICONS[ch.id] || '');
    icon.classList.add('char-icon');
    btn.appendChild(icon);

    var label = document.createElement('span');
    label.className = 'char-name';
    label.textContent = ch.name;
    btn.appendChild(label);

    // Wave 4 — probability toggle: a small badge on the card. Clicking it
    // (not the card) flips the random-chance gate for this character.
    if (ch.prob) {
      var probBtn = document.createElement('span');
      probBtn.className = 'prob-btn';
      probBtn.setAttribute('role', 'button');
      probBtn.setAttribute('tabindex', '0');
      probBtn.title = i18n.t('prob.title', { pct: Math.round(ch.prob * 100) });
      probBtn.textContent = 'P';
      probBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleProb(ch.id);
      });
      probBtn.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          toggleProb(ch.id);
        }
      });
      btn.appendChild(probBtn);
    }

    // Long-press (accent) state for this button. A quick tap should produce
    // exactly ONE sound (the click -> playOnce). Holding >= ACCENT_DELAY ms
    // fires the accent flam instead, and the release click is suppressed.
    var accentTimer = null;
    var accentFired = false;

    function clearAccentTimer() {
      if (accentTimer !== null) {
        clearTimeout(accentTimer);
        accentTimer = null;
      }
    }

    function releaseHold() {
      clearAccentTimer();
      btn.classList.remove('holding');
    }

    btn.addEventListener('click', function () {
      if (accentFired) {
        // A long press already fired the accent; suppress the release click
        // entirely (no toggle, no playOnce) so the flam is not doubled.
        return;
      }
      onCharClick(ch);
    });

    // Wave 3 — intensity: holding a character fires an extra accent.
    btn.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) {
        return; // left button only
      }
      audio.ensure();
      accentFired = false;
      clearAccentTimer();
      accentTimer = setTimeout(function () {
        accentTimer = null;
        accentFired = true;
        audio.playAccent(ch.id);
        btn.classList.add('holding');
      }, 200);
    });
    btn.addEventListener('pointerup', releaseHold);
    btn.addEventListener('pointerleave', releaseHold);
    btn.addEventListener('pointercancel', releaseHold);

    return btn;
  }

  function buildGrid() {
    var kit = currentKit();
    data.rows.forEach(function (row, r) {
      var section = document.createElement('section');
      section.className = 'row row-' + row.id;
      section.dataset.row = r;

      // Row side panel: name, mute, volume
      var side = document.createElement('div');
      side.className = 'row-side';

      var name = document.createElement('span');
      name.className = 'row-name';
      name.textContent = i18n.t('row.' + row.id);
      side.appendChild(name);

      var muteBtn = document.createElement('button');
      muteBtn.type = 'button';
      muteBtn.className = 'mute-btn';
      muteBtn.title = i18n.t('mute') + ' ' + i18n.t('row.' + row.id);
      muteBtn.appendChild(speakerSvg(false));
      side.appendChild(muteBtn);

      var vol = document.createElement('input');
      vol.type = 'range';
      vol.className = 'row-volume';
      vol.min = 0;
      vol.max = 100;
      vol.step = 1;
      vol.value = 80;
      vol.setAttribute('aria-label', i18n.t('row.' + row.id) + ' ' + i18n.t('volume'));
      side.appendChild(vol);

      // Row cards
      var cards = document.createElement('div');
      cards.className = 'row-cards';
      kit.characters.forEach(function (ch) {
        if (ch.row === r) {
          var btn = buildCharCard(ch);
          charEls[ch.id] = btn;
          cards.appendChild(btn);
        }
      });

      section.appendChild(side);
      section.appendChild(cards);
      gridEl.appendChild(section);
      rowEls.push(section);

      setupRowControls(section, r, muteBtn, vol);
    });
  }

  function stepsPerBar() {
    return state.timeSignature === '3/4' ? 12 : state.timeSignature === '2/4' ? 8 : 16;
  }

  function buildStepIndicator() {
    rebuildStepIndicator();
  }

  function rebuildStepIndicator() {
    stepIndicator.replaceChildren();
    stepDots = [];
    for (var i = 0; i < stepsPerBar(); i++) {
      var dot = document.createElement('span');
      dot.className = 'step-dot';
      stepIndicator.appendChild(dot);
      stepDots.push(dot);
    }
  }

  // Reflect the current time signature on the segmented control buttons.
  function updateTimeSigButtons() {
    for (var i = 0; i < timeSigButtons.length; i++) {
      var on = timeSigButtons[i].getAttribute('data-sig') === state.timeSignature;
      timeSigButtons[i].classList.toggle('active', on);
      timeSigButtons[i].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  /* ------------------------- interactions --------------------------------- */

  function onCharClick(ch) {
    audio.ensure();

    // One-shot characters fire once on click; they never join the loop.
    if (ch.oneShot) {
      audio.playOnce(ch.id);
      flashChar(ch.id);
      return;
    }

    var on = !activeSet()[ch.id];
    setCharActive(ch.id, on);
    audio.setActive(ch.id, on);
    audio.playOnce(ch.id); // instant preview feedback
    save();
  }

  // Brief visual flash for one-shot hits (no persistent active state).
  function flashChar(id) {
    var el = charEls[id];
    if (!el) {
      return;
    }
    el.classList.add('flash');
    setTimeout(function () {
      el.classList.remove('flash');
    }, 220);
  }

  /* ------------------------- dynamic actions (Wave 3) -------------------- */

  function randomMix() {
    audio.ensure();
    var kit = currentKit();
    var pool = kit.characters.filter(function (c) {
      return !c.oneShot;
    });
    if (pool.length === 0) {
      return;
    }

    // Clear the current mix.
    Object.keys(activeSet()).forEach(function (id) {
      setCharActive(id, false);
      audio.setActive(id, false);
    });

    // Activate a random 4-7 of them.
    var count = 4 + Math.floor(Math.random() * Math.min(4, pool.length - 3));
    var shuffled = pool.slice().sort(function () {
      return Math.random() - 0.5;
    });
    for (var i = 0; i < count; i++) {
      var ch = shuffled[i];
      setCharActive(ch.id, true);
      audio.setActive(ch.id, true);
    }

    // If nothing is playing, start playback so the mix is audible right away.
    if (!audio.isPlaying()) {
      audio.start();
      updatePlayBtn();
    }
    save();
  }

  function setupDynamicActions() {
    randomBtn.addEventListener('click', function () {
      randomMix();
    });
  }

  /* ------------------------- settings modal ------------------------------- */

  // Show the top-level menu and hide both sub-panels.
  function showSettingsMenu() {
    settingsMenu.hidden = false;
    creditsPanel.hidden = true;
    languagePanel.hidden = true;
  }

  function showCreditsPanel() {
    settingsMenu.hidden = true;
    creditsPanel.hidden = false;
    languagePanel.hidden = true;
  }

  function showLanguagePanel() {
    settingsMenu.hidden = true;
    creditsPanel.hidden = true;
    languagePanel.hidden = false;
  }

  function openModal() {
    settingsModal.hidden = false;

    // Mark the current language in the picker.
    for (var i = 0; i < langButtons.length; i++) {
      langButtons[i].classList.toggle('active', langButtons[i].getAttribute('data-lang') === i18n.getLang());
    }

    if (settingsClose) {
      settingsClose.focus();
    }
  }

  function closeModal() {
    settingsModal.hidden = true;
    if (settingsBtn) {
      settingsBtn.focus();
    }
  }

  function setupSettings() {
    if (!settingsBtn || !settingsModal) {
      return;
    }

    settingsBtn.addEventListener('click', function () {
      audio.ensure(); // first user gesture resumes the AudioContext
      showSettingsMenu();
      openModal();
    });

    // Home-only transport buttons: open the modal straight into the
    // Credits / Language sub-panel (the Settings menu is skipped).
    if (creditsBtn) {
      creditsBtn.addEventListener('click', function () {
        audio.ensure();
        showCreditsPanel();
        openModal();
      });
    }
    if (langBtn) {
      langBtn.addEventListener('click', function () {
        audio.ensure();
        showLanguagePanel();
        openModal();
      });
    }

    if (settingsClose) {
      settingsClose.addEventListener('click', closeModal);
    }

    // Backdrop click closes the modal — only when the click hit the overlay
    // itself, not the panel (clicks inside the panel bubble up with a
    // different target).
    settingsModal.addEventListener('click', function (e) {
      if (e.target === settingsModal) {
        closeModal();
      }
    });

    // ESC closes the modal.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !settingsModal.hidden) {
        closeModal();
      }
    });

    if (creditsEntry) {
      creditsEntry.addEventListener('click', showCreditsPanel);
    }
    if (creditsBack) {
      creditsBack.addEventListener('click', showSettingsMenu);
    }
    if (languageEntry) {
      languageEntry.addEventListener('click', showLanguagePanel);
    }
    if (languageBack) {
      languageBack.addEventListener('click', showSettingsMenu);
    }

    for (var i = 0; i < langButtons.length; i++) {
      langButtons[i].addEventListener('click', function () {
        i18n.setLang(this.getAttribute('data-lang'));
        // Re-applies [data-i18n] across the whole document; the modal is
        // static markup so its labels refresh here too.
        i18n.applyI18n();
        closeModal();
      });
    }
  }

  function setCharActive(id, on) {
    if (on) {
      activeSet()[id] = true;
    } else {
      delete activeSet()[id];
    }
    var el = charEls[id];
    if (el) {
      el.classList.toggle('active', on);
      el.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  /* ------------------------- probability (Wave 4) ------------------------ */

  function toggleProb(id) {
    var on = !state.probOn[id];
    if (on) {
      state.probOn[id] = true;
    } else {
      delete state.probOn[id];
    }
    audio.setProb(id, on);
    var el = charEls[id];
    if (el) {
      el.classList.toggle('prob-on', on);
    }
    save();
  }

  // Reflect saved probability toggles on the freshly built grid.
  function applyProbBadges() {
    currentKit().characters.forEach(function (ch) {
      if (state.probOn[ch.id]) {
        var el = charEls[ch.id];
        if (el) {
          el.classList.add('prob-on');
        }
      }
    });
  }

  function setupRowControls(section, r, muteBtn, vol) {
    muteBtn.addEventListener('click', function () {
      state.rows[r].muted = !state.rows[r].muted;
      muteBtn.classList.toggle('muted', state.rows[r].muted);
      muteBtn.title = (state.rows[r].muted ? i18n.t('unmute') : i18n.t('mute')) + ' ' + i18n.t('row.' + data.rows[r].id);
      muteBtn.replaceChildren(speakerSvg(state.rows[r].muted));
      audio.setRowMuted(r, state.rows[r].muted);
      save();
    });

    vol.addEventListener('input', function () {
      var pct = parseInt(vol.value, 10);
      state.rows[r].volume = pct;
      audio.setRowVolume(r, pct / 100);
      save();
    });
  }

  function updatePlayBtn() {
    var playing = audio.isPlaying();
    var label = i18n.t(playing ? 'stop' : 'play');
    playBtn.classList.toggle('playing', playing);
    playBtn.setAttribute('aria-label', label);
    playBtn.title = label;
    playBtn.querySelector('.play-label').textContent = label;
  }

  function setupTransport() {
    playBtn.addEventListener('click', function () {
      audio.ensure();
      audio.toggle();
      updatePlayBtn();
    });

    bpmSlider.addEventListener('input', function () {
      state.bpm = parseInt(bpmSlider.value, 10);
      bpmValue.textContent = state.bpm;
      audio.setBpm(state.bpm);
      save();
    });

    // Time signature segmented control (2/4, 3/4, 4/4).
    for (var i = 0; i < timeSigButtons.length; i++) {
      timeSigButtons[i].addEventListener('click', function () {
        state.timeSignature = this.getAttribute('data-sig');
        audio.setTimeSignature(state.timeSignature);
        rebuildStepIndicator();
        updateTimeSigButtons();
        save();
      });
    }

    audio.onStep = function (s) {
      stepDots.forEach(function (dot, i) {
        dot.classList.toggle('on', i === s);
      });
    };

    // Space bar toggles play (as long as the user isn't typing).
    document.addEventListener('keydown', function (e) {
      var tag = e.target && e.target.tagName;
      if (e.code === 'Space' && !/INPUT|BUTTON|TEXTAREA|SELECT/.test(tag || '')) {
        e.preventDefault();
        audio.ensure();
        audio.toggle();
        updatePlayBtn();
      }
    });
  }

  /* ------------------------- i18n re-render ------------------------------- */

  // Re-render every dynamic string after a language change.
  function refreshI18n() {
    updatePlayBtn();

    // Home-only language button label: "{currentLang}/Languages", or just
    // "Languages" when the app is already in English.
    if (langBtn) {
      var langName = i18n.t('lang.' + i18n.getLang());
      langBtn.textContent = i18n.getLang() === 'en' ? i18n.t('languages') : langName + '/' + i18n.t('languages');
    }

    // Home pill label + tooltip.
    if (homePill) {
      var homeNameEl = homePill.querySelector('.kit-pill-name');
      if (homeNameEl) {
        homeNameEl.textContent = i18n.t('home');
      }
      homePill.title = i18n.t('home.title');
    }

    data.rows.forEach(function (row, r) {
      var section = rowEls[r];
      if (!section) {
        return;
      }
      var rowName = i18n.t('row.' + row.id);
      var nameEl = section.querySelector('.row-name');
      if (nameEl) {
        nameEl.textContent = rowName;
      }
      var muteBtn = section.querySelector('.mute-btn');
      if (muteBtn) {
        muteBtn.title = (state.rows[r].muted ? i18n.t('unmute') : i18n.t('mute')) + ' ' + rowName;
      }
      var vol = section.querySelector('.row-volume');
      if (vol) {
        vol.setAttribute('aria-label', rowName + ' ' + i18n.t('volume'));
      }
    });

    Object.keys(charEls).forEach(function (id) {
      var ch = charById(id);
      var el = charEls[id];
      if (!ch || !el) {
        return;
      }
      el.title = charTitle(ch);
      if (ch.prob) {
        var probBtn = el.querySelector('.prob-btn');
        if (probBtn) {
          probBtn.title = i18n.t('prob.title', { pct: Math.round(ch.prob * 100) });
        }
      }
    });
  }

  /* ------------------------- persistence ---------------------------------- */

  function save() {
    try {
      var payload = {
        currentKit: state.currentKit,
        activeByKit: state.activeByKit,
        probOn: state.probOn,
        bpm: state.bpm,
        timeSignature: state.timeSignature,
        rows: state.rows
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (err) {
      // storage unavailable (private mode, file:// restrictions) — ignore
    }
  }

  function load() {
    var raw;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (err) {
      return;
    }
    if (!raw) {
      return;
    }

    var saved;
    try {
      saved = JSON.parse(raw);
    } catch (err) {
      return; // corrupted state — start fresh
    }

    if (saved.currentKit && data.kits.some(function (k) { return k.id === saved.currentKit; })) {
      state.currentKit = saved.currentKit;
    }

    if (saved.activeByKit && typeof saved.activeByKit === 'object') {
      state.activeByKit = saved.activeByKit;
    }

    if (saved.probOn && typeof saved.probOn === 'object') {
      state.probOn = saved.probOn;
      Object.keys(state.probOn).forEach(function (id) {
        audio.setProb(id, true);
      });
    }

    if (typeof saved.bpm === 'number') {
      state.bpm = Math.min(180, Math.max(60, saved.bpm));
      bpmSlider.value = state.bpm;
      bpmValue.textContent = state.bpm;
      audio.setBpm(state.bpm);
    }

    if (saved.timeSignature === '2/4' || saved.timeSignature === '3/4' || saved.timeSignature === '4/4') {
      state.timeSignature = saved.timeSignature;
      audio.setTimeSignature(state.timeSignature);
      updateTimeSigButtons();
      rebuildStepIndicator();
    }

    if (Array.isArray(saved.rows)) {
      saved.rows.forEach(function (r, i) {
        if (!r || !rowEls[i]) {
          return;
        }
        state.rows[i] = {
          muted: !!r.muted,
          volume: typeof r.volume === 'number' ? r.volume : 80
        };
        var muteBtn = rowEls[i].querySelector('.mute-btn');
        var vol = rowEls[i].querySelector('.row-volume');
        muteBtn.classList.toggle('muted', state.rows[i].muted);
        muteBtn.title = (state.rows[i].muted ? i18n.t('unmute') : i18n.t('mute')) + ' ' + i18n.t('row.' + data.rows[i].id);
        muteBtn.replaceChildren(speakerSvg(state.rows[i].muted));
        vol.value = state.rows[i].volume;
        audio.setRowMuted(i, state.rows[i].muted);
        audio.setRowVolume(i, state.rows[i].volume / 100);
      });
    }
  }

  /* ------------------------- init ------------------------------------------ */

  function init() {
    audio.init(data);
    audio.setTimeSignature(state.timeSignature); // default 4/4
    buildKitBar();
    buildGrid();
    buildStepIndicator();
    setupTransport();
    setupDynamicActions();
    setupSettings();
    load();

    // The grid was built for the default kit; if a saved kit differs, rebuild.
    if (state.currentKit !== data.kits[0].id) {
      gridEl.replaceChildren();
      rowEls = [];
      charEls = {};
      buildGrid();
    }
    applyProbBadges();

    // Re-arm characters saved for the current kit.
    var saved = state.activeByKit[state.currentKit] || {};
    Object.keys(saved).forEach(function (id) {
      var ch = charById(id);
      if (ch && !ch.oneShot) {
        setCharActive(id, true);
        audio.setActive(id, true);
      }
    });

    // Reflect the current kit on the pills.
    Object.keys(kitPills).forEach(function (id) {
      var on = id === state.currentKit;
      kitPills[id].classList.toggle('active', on);
      kitPills[id].setAttribute('aria-selected', on ? 'true' : 'false');
    });

    updatePlayBtn();

    // Home Start button — jump to the first kit and start building.
    if (homeStart) {
      homeStart.addEventListener('click', function () {
        switchKit(data.kits[0].id);
      });
    }

    // Present the software on load (the Home landing screen).
    showHome();

    // i18n: apply static translations, then re-render dynamic strings.
    PlayMusikI18n.onApply = refreshI18n;
    PlayMusikI18n.applyI18n();
  }

  document.addEventListener('DOMContentLoaded', init);
})();