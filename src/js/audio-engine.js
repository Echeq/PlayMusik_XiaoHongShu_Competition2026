/* ==========================================================================
   Play Musik — audio-engine.js
   All sound is synthesized at runtime with the Web Audio API. Zero audio
   files, zero network.

   Design:
   - ONE AudioContext, created lazily on the first user gesture.
   - Gain chain: row gains (4) -> master -> compressor -> destination.
   - Lookahead scheduler ("A Tale of Two Clocks"): a ~25ms setInterval
     schedules notes ~100ms ahead of audioContext.currentTime, so loops
     stay sample-accurate with no drift.
   - Melodic presets read a 16-note sequence keyed by the step index.

   API (PlayMusikAudio):
     init(data)            store PlayMusikData
     ensure()              create/resume the AudioContext (call in a gesture)
     setKit(kitId)         switch the active kit (clears armed characters)
     getKitId()            id of the active kit
     playOnce(charId)      immediate preview of one character
     start() / stop()      transport
     toggle()              play/stop
     isPlaying()           bool
     setBpm(v)             tempo (16th-note grid)
     setActive(charId, on) arm/disarm a character's loop
     setRowMuted(row, m)   mute a row (row gain to 0)
     setRowVolume(row, v)  row volume 0..1
     onStep(step, time)    callback for the UI (step = -1 when stopped)
   ========================================================================== */

'use strict';

var PlayMusikAudio = (function () {
  var ctx = null;          // single AudioContext
  var master = null;       // master gain
  var masterFilter = null; // global BiquadFilter (Filter Sweep effect)
  var sidechainGain = null; // global modulated gain (Sidechain effect)
  var rowGains = [];       // one gain per row (mute/volume)
  var noiseBuffer = null;  // shared white-noise buffer

  var playing = false;
  var timerId = null;
  var step = 0;            // scheduler position (16-step loop)
  var nextStepTime = 0;    // audio-clock time of the next step
  var bpm = 100;
  var stepsPerBar = 16;    // steps per bar (16 = 4/4, 12 = 3/4, 8 = 2/4)

  var data = null;         // PlayMusikData
  var currentKit = null;   // active kit object (data.kits[i])
  var active = {};         // charId -> true (armed characters)

  var rowMuted = [false, false, false, false];
  var rowVolume = [0.8, 0.8, 0.8, 0.8];

  var autoFill = false;    // Wave 3: insert a drum fill every N bars
  var FILL_EVERY = 4;      // fill lands on the 4th bar of each cycle
  var FILL_PATTERN = '........X.X.X.X.'; // second half of the bar

  var probOn = {};         // Wave 4: charId -> true (probability gate enabled)
  var ENERGY_MAX = 8;      // active characters needed to max the energy meter

  var panForStep = null;   // Wave 5: pan value for the current synth call

  var TICK_MS = 25;        // scheduler wake-up interval
  var LOOKAHEAD_MS = 100;  // how far ahead we schedule notes

  /* ------------------------- helpers ------------------------------------ */

  function midiToFreq(m) {
    return 440 * Math.pow(2, (m - 69) / 12);
  }

  // one 16th note at the current BPM
  function stepDuration() {
    return 60 / bpm / 4;
  }

  function charById(id) {
    if (!currentKit) {
      return null;
    }
    for (var i = 0; i < currentKit.characters.length; i++) {
      if (currentKit.characters[i].id === id) {
        return currentKit.characters[i];
      }
    }
    return null;
  }

  // looping white-noise source (started at `time`)
  function noiseSource(time) {
    var src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    src.start(time);
    return src;
  }

  // Wave 5: route a synth's output to its row gain, optionally through a
  // StereoPannerNode. `panForStep` is set by the scheduler before each call.
  function connectRow(node, row) {
    if (panForStep === null || panForStep === undefined || !ctx.createStereoPanner) {
      node.connect(rowGains[row]);
      return;
    }
    var p = ctx.createStereoPanner();
    p.pan.value = panForStep;
    node.connect(p);
    p.connect(rowGains[row]);
  }

  // Wave 5: resolve a character's pan setting for a given step.
  // 'alt' alternates L/R in 2-step groups (so even-step patterns still
  // bounce); a number is a fixed position.
  function panForChar(ch, stepIndex) {
    if (ch.pan === 'alt') {
      return Math.floor(stepIndex / 2) % 2 === 0 ? -0.5 : 0.5;
    }
    if (typeof ch.pan === 'number') {
      return ch.pan;
    }
    return null;
  }

  /* ------------------------- context & chain ----------------------------- */

  // Create the context + gain chain on the first user gesture.
  function ensure() {
    if (ctx) {
      if (ctx.state === 'suspended') {
        ctx.resume();
      }
      return ctx;
    }

    var AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();

    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;

    master = ctx.createGain();
    master.gain.value = 0.9;

    // Global FX nodes, transparent by default: row gains -> master ->
    // masterFilter -> sidechainGain -> compressor -> destination. The Filter
    // Sweep and Sidechain characters modulate these two nodes.
    masterFilter = ctx.createBiquadFilter();
    masterFilter.type = 'lowpass';
    masterFilter.frequency.value = 20000;
    masterFilter.Q.value = 0.5;

    sidechainGain = ctx.createGain();
    sidechainGain.gain.value = 1;

    master.connect(masterFilter);
    masterFilter.connect(sidechainGain);
    sidechainGain.connect(comp);
    comp.connect(ctx.destination);

    for (var i = 0; i < 4; i++) {
      var g = ctx.createGain();
      // honor any volume/mute restored from localStorage before the context existed
      g.gain.value = rowMuted[i] ? 0 : rowVolume[i];
      g.connect(master);
      rowGains.push(g);
    }

    // 1 second of shared white noise (looped, so any effect length works)
    var len = Math.floor(ctx.sampleRate);
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    var ch = noiseBuffer.getChannelData(0);
    for (var j = 0; j < len; j++) {
      ch[j] = Math.random() * 2 - 1;
    }

    return ctx;
  }

  /* ------------------------- synth presets ------------------------------- */
  /* Every preset is a function (time, row, stepIndex) that builds its own
     nodes and connects to the row gain. `step` lets melodic presets walk
     a note sequence so patterns become little melodies.                   */

  // 16-note sequences (A minor pentatonic flavored)
  var bassline = [33, 33, 40, 33, 36, 33, 43, 38, 33, 36, 40, 38, 43, 40, 45, 40];
  var leadline = [57, 60, 64, 62, 60, 55, 57, 59, 64, 67, 69, 67, 64, 62, 60, 57];
  var arpline = [57, 60, 64, 69, 72, 69, 64, 60, 57, 64, 60, 67, 64, 60, 55, 60];
  var chantline = [45, 45, 52, 48, 45, 43, 40, 48, 45, 50, 52, 48, 45, 43, 45, 48];
  var oohline = [57, 60, 64, 62, 60, 57, 55, 57, 64, 67, 69, 67, 64, 60, 62, 60];

  // Jazz kit sequences (A minor / ii-V-I flavored)
  var jazzbass = [33, 35, 36, 35, 38, 41, 45, 48, 31, 35, 38, 41, 36, 40, 43, 48];
  var jazzcomp = [45, 50, 43, 48]; // chord roots per bar: A-7, D7, G7, Cmaj7
  var saxline = [57, 60, 64, 63, 60, 57, 55, 57, 60, 64, 67, 64, 60, 59, 57, 55];
  var scatline = [57, 60, 64, 62, 60, 57, 55, 57, 60, 64, 67, 64, 60, 62, 64, 60];
  var humline = [45, 48, 52, 50, 48, 45, 43, 45, 48, 52, 55, 52, 48, 50, 48, 45];
  var bopline = [57, 60, 64, 60, 57, 55, 57, 60, 64, 67, 64, 60, 57, 59, 60, 57];

  // RNB kit sequences (A minor / Dm7-G7 flavored)
  var rnbbass = [33, 33, 40, 33, 36, 33, 43, 38, 33, 36, 40, 38, 43, 40, 45, 40];
  var rhodesline = [57, 60, 64, 62, 60, 57, 55, 57, 64, 67, 69, 67, 64, 60, 62, 60];
  var guitarline = [45, 48, 52, 50, 48, 45, 43, 45, 48, 52, 55, 52, 48, 50, 48, 45];
  var soulline = [57, 60, 64, 62, 60, 57, 55, 57, 60, 64, 67, 64, 60, 62, 64, 60];
  var adlibline = [60, 64, 67, 64, 60, 62, 64, 60, 57, 60, 64, 62, 60, 57, 55, 57];
  var rnboohline = [45, 48, 52, 50, 48, 45, 43, 45, 48, 52, 55, 52, 48, 50, 48, 45];

  // Salsa kit sequences (A minor / C major flavored)
  var montunoline = [57, 60, 64, 65, 64, 60, 57, 55, 57, 60, 64, 67, 64, 60, 57, 55];
  var tumbaoline = [33, 33, 33, 33, 33, 33, 40, 33, 33, 33, 33, 33, 45, 33, 44, 33];
  var trumpline = [60, 64, 67, 65, 64, 60, 57, 55, 60, 64, 67, 69, 67, 64, 62, 60];
  var coroline = [45, 48, 52, 50, 48, 45, 43, 45, 48, 52, 55, 52, 48, 50, 48, 45];
  var soneoline = [57, 60, 64, 62, 60, 57, 55, 57, 60, 64, 67, 64, 60, 62, 64, 60];

  // Circuit kit sequence (Talkbox vocoder voice)
  var talkboxline = [57, 60, 64, 62, 60, 57, 55, 57, 64, 67, 69, 67, 64, 60, 62, 60];

  // Bossa Nova kit sequences (A minor / Dm7-G7 flavored, soft)
  var bossapianoline = [57, 60, 64, 62, 60, 57, 55, 57, 64, 67, 69, 67, 64, 60, 62, 60];
  var bossasaxline = [57, 60, 64, 63, 60, 57, 55, 57, 60, 64, 67, 64, 60, 59, 57, 55];
  var bossabassline = [33, 33, 40, 33, 36, 33, 43, 38, 33, 36, 40, 38, 43, 40, 45, 40];
  var bossavoiceline = [57, 60, 64, 62, 60, 57, 55, 57, 64, 67, 69, 67, 64, 60, 62, 60];
  var bossachoirline = [45, 48, 52, 50, 48, 45, 43, 45, 48, 52, 55, 52, 48, 50, 48, 45];

  // K-Pop kit sequences (C major pentatonic — bright, catchy, pop hooks)
  var kppsynthline = [60, 64, 67, 72, 67, 64, 60, 64, 67, 69, 72, 69, 67, 64, 60, 64];
  var kpoppianoline = [60, 64, 67, 72, 76, 72, 67, 64, 60, 64, 67, 69, 72, 67, 64, 60];
  var kpopbassline = [36, 36, 43, 36, 40, 36, 45, 40, 36, 40, 43, 40, 45, 43, 40, 36];
  var kpopvocalline = [64, 67, 72, 67, 64, 62, 64, 67, 72, 74, 72, 67, 64, 62, 60, 64];
  var kpopchantline = [60, 64, 67, 64, 60, 62, 64, 60, 57, 60, 64, 62, 60, 57, 55, 57];

  // Trap kit sequences (dark, minor)
  var trapsynthline = [45, 48, 52, 50, 48, 45, 43, 45, 48, 52, 55, 52, 48, 50, 48, 45];
  var trappianoline = [57, 60, 64, 62, 60, 57, 55, 57, 60, 64, 67, 64, 60, 62, 64, 60];
  var trapbassline = [33, 33, 33, 33, 36, 33, 40, 33, 33, 33, 36, 33, 43, 40, 45, 40];
  var trapvocalline = [57, 60, 64, 60, 57, 55, 57, 60, 64, 67, 64, 60, 57, 59, 60, 57];

  // Lo-Fi kit sequences (mellow, nostalgic)
  var lofipianoline = [57, 60, 64, 62, 60, 57, 55, 57, 64, 67, 69, 67, 64, 60, 62, 60];
  var lofiguitarline = [45, 48, 52, 50, 48, 45, 43, 45, 48, 52, 55, 52, 48, 50, 48, 45];
  var lofibassline = [33, 33, 40, 33, 36, 33, 43, 38, 33, 36, 40, 38, 43, 40, 45, 40];
  var lofivocalline = [45, 48, 52, 50, 48, 45, 43, 45, 48, 52, 55, 52, 48, 50, 48, 45];

  var synths = {

    /* Kick — sine with fast pitch drop (150 -> 46 Hz). */
    kick: function (time, row) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(155, time);
      osc.frequency.exponentialRampToValueAtTime(46, time + 0.11);

      var g = ctx.createGain();
      g.gain.setValueAtTime(1.0, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.26);

      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.3);
    },

    /* Snare — filtered noise + a short tonal body. */
    snare: function (time, row) {
      var noise = noiseSource(time);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1900;
      bp.Q.value = 0.9;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.9, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.2);

      noise.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.24);

      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(185, time);

      var og = ctx.createGain();
      og.gain.setValueAtTime(0.5, time);
      og.gain.exponentialRampToValueAtTime(0.001, time + 0.12);

      osc.connect(og);
      connectRow(og, row);
      osc.start(time);
      osc.stop(time + 0.15);
    },

    /* Hi-Hat — very short high-passed noise. */
    hihat: function (time, row) {
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 7500;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.35, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.06);

      noise.connect(hp);
      hp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.08);
    },

    /* Scratch — sawtooth with fast random pitch jumps through a bandpass. */
    scratch: function (time, row) {
      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';

      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1100;
      bp.Q.value = 2.5;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);

      var t = time;
      for (var i = 0; i < 5; i++) {
        osc.frequency.setValueAtTime(300 + Math.random() * 1500, t);
        t += 0.018;
      }

      g.gain.setValueAtTime(0.28, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.15);

      osc.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.18);
    },

    /* Boom — big sub drop + low noise thump. */
    boom: function (time, row) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(95, time);
      osc.frequency.exponentialRampToValueAtTime(32, time + 0.5);

      var g = ctx.createGain();
      g.gain.setValueAtTime(1, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.65);

      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.7);

      var noise = noiseSource(time);
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 320;

      var ng = ctx.createGain();
      ng.gain.setValueAtTime(0.7, time);
      ng.gain.exponentialRampToValueAtTime(0.001, time + 0.4);

      noise.connect(lp);
      lp.connect(ng);
      connectRow(ng, row);
      noise.stop(time + 0.45);
    },

    /* Zap — square wave sweeping down through a highpass. */
    zap: function (time, row) {
      var osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(2100, time);
      osc.frequency.exponentialRampToValueAtTime(160, time + 0.1);

      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 900;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.3, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.14);

      osc.connect(hp);
      hp.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.16);
    },

    /* Bass — saw + sub sine through a closing lowpass. */
    bass: function (time, row, step) {
      var freq = midiToFreq(bassline[step % 16]);

      var saw = ctx.createOscillator();
      saw.type = 'sawtooth';
      saw.frequency.value = freq;

      var sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = freq / 2;

      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(850, time);
      lp.frequency.exponentialRampToValueAtTime(140, time + 0.2);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.4, time + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.26);

      saw.connect(lp);
      sub.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      saw.start(time);
      sub.start(time);
      saw.stop(time + 0.3);
      sub.stop(time + 0.3);
    },

    /* Lead — two detuned saws with a bright->dark filter sweep. */
    lead: function (time, row, step) {
      var freq = midiToFreq(leadline[step % 16]);

      var o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = freq;

      var o2 = ctx.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.value = freq * 1.007; // detuned

      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(2600, time);
      lp.frequency.exponentialRampToValueAtTime(700, time + 0.22);
      lp.Q.value = 3;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.22, time + 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.3);

      o1.connect(lp);
      o2.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o1.stop(time + 0.34);
      o2.stop(time + 0.34);
    },

    /* Arp — bright plucks walking a chord-tone sequence (an octave up). */
    arp: function (time, row, step) {
      var freq = midiToFreq(arpline[step % 16] + 12);

      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.4, time + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.12);

      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.15);
    },

    /* Chant — sawtooth through an "ah" formant bandpass with vibrato. */
    chant: function (time, row, step) {
      var freq = midiToFreq(chantline[step % 16]);

      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;

      var form = ctx.createBiquadFilter();
      form.type = 'bandpass';
      form.frequency.value = 820;
      form.Q.value = 4;

      var lfo = ctx.createOscillator();
      lfo.frequency.value = 5.2;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 3.5;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.06);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.42);

      osc.connect(form);
      form.connect(g);
      connectRow(g, row);
      osc.start(time);
      lfo.start(time);
      osc.stop(time + 0.46);
      lfo.stop(time + 0.46);
    },

    /* Beatbox — "boots & cats": even steps kick-ish, odd steps hat-ish. */
    beatbox: function (time, row, step) {
      if (step % 2 === 0) {
        // boot
        var osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(130, time);
        osc.frequency.exponentialRampToValueAtTime(55, time + 0.09);

        var g = ctx.createGain();
        g.gain.setValueAtTime(0.8, time);
        g.gain.exponentialRampToValueAtTime(0.001, time + 0.16);

        osc.connect(g);
        connectRow(g, row);
        osc.start(time);
        osc.stop(time + 0.2);
      } else {
        // cat
        var noise = noiseSource(time);
        var hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 6500;

        var g2 = ctx.createGain();
        g2.gain.setValueAtTime(0.22, time);
        g2.gain.exponentialRampToValueAtTime(0.001, time + 0.07);

        noise.connect(hp);
        hp.connect(g2);
        connectRow(g2, row);
        noise.stop(time + 0.09);
      }
    },

    /* Ooh — warm sine with vibrato and a gentle vowel envelope. */
    ooh: function (time, row, step) {
      var freq = midiToFreq(oohline[step % 16]);

      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;

      var warm = ctx.createBiquadFilter();
      warm.type = 'lowpass';
      warm.frequency.value = 1500;

      var lfo = ctx.createOscillator();
      lfo.frequency.value = 4.8;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 4;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.32, time + 0.07);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

      osc.connect(warm);
      warm.connect(g);
      connectRow(g, row);
      osc.start(time);
      lfo.start(time);
      osc.stop(time + 0.55);
      lfo.stop(time + 0.55);
    },

    /* ======================================================================
       Kit 2 — Neon presets
       ====================================================================== */

    /* Toms — three tuned drums walking a pitch sequence. */
    toms: function (time, row, step) {
      var seq = [62, 65, 69, 65];
      var freq = midiToFreq(seq[step % 4]);

      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * 1.5, time);
      osc.frequency.exponentialRampToValueAtTime(freq, time + 0.05);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.7, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.22);

      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.26);
    },

    /* Clap — three quick noise bursts, then a longer body (classic clap). */
    clap: function (time, row) {
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1400;
      bp.Q.value = 1.2;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      var t = time;
      for (var i = 0; i < 3; i++) {
        g.gain.setValueAtTime(0.5, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.012);
        t += 0.014;
      }
      g.gain.setValueAtTime(0.5, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);

      var noise = noiseSource(time);
      noise.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      noise.stop(t + 0.2);
    },

    /* Shaker — bright highpassed noise, very short. */
    shaker: function (time, row) {
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 6000;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.3, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

      noise.connect(hp);
      hp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.07);
    },

    /* Air Horn — two detuned saws a semitone apart, slow attack, long blast. */
    airhorn: function (time, row) {
      var o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = 440;
      var o2 = ctx.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.value = 466.16;

      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2400;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.35, time + 0.12);
      g.gain.setValueAtTime(0.35, time + 0.7);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.95);

      o1.connect(lp);
      o2.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o1.stop(time + 1.0);
      o2.stop(time + 1.0);
    },

    /* Vinyl Scratch — noise through a resonant bandpass with random jumps. */
    vinyl: function (time, row) {
      var noise = noiseSource(time);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 6;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      var t = time;
      for (var i = 0; i < 6; i++) {
        bp.frequency.setValueAtTime(400 + Math.random() * 2600, t);
        t += 0.02;
      }
      g.gain.setValueAtTime(0.4, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.16);

      noise.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.2);
    },

    /* Riser — noise swelling up through a rising bandpass (builds tension). */
    riser: function (time, row) {
      var noise = noiseSource(time);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.5;
      bp.frequency.setValueAtTime(300, time);
      bp.frequency.exponentialRampToValueAtTime(6000, time + 1.6);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.4, time + 1.5);
      g.gain.exponentialRampToValueAtTime(0.001, time + 1.8);

      noise.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      noise.stop(time + 1.85);
    },

    /* Piano — sine with a bright attack click and a long decay. */
    piano: function (time, row, step) {
      var freq = midiToFreq(leadline[step % 16]);

      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.45, time + 0.005);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.8);

      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.85);

      // hammer click
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3000;
      var ng = ctx.createGain();
      ng.gain.setValueAtTime(0.12, time);
      ng.gain.exponentialRampToValueAtTime(0.001, time + 0.02);
      noise.connect(hp);
      hp.connect(ng);
      connectRow(ng, row);
      noise.stop(time + 0.03);
    },

    /* Pluck — saw through a fast-closing lowpass (plucked string). */
    pluck: function (time, row, step) {
      var freq = midiToFreq(arpline[step % 16]);

      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;

      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(3200, time);
      lp.frequency.exponentialRampToValueAtTime(500, time + 0.12);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.42, time + 0.006);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.2);

      osc.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.24);
    },

    /* Chiptune — square wave, fast decay, tiny vibrato (8-bit). */
    chiptune: function (time, row, step) {
      var freq = midiToFreq(arpline[step % 16] + 12);

      var osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;

      var lfo = ctx.createOscillator();
      lfo.frequency.value = 9;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 6;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.35, time + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.16);

      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      lfo.start(time);
      osc.stop(time + 0.2);
      lfo.stop(time + 0.2);
    },

    /* Hey — formant "eh" shout: saw through a bandpass with a pitch bounce. */
    hey: function (time, row, step) {
      var freq = midiToFreq(chantline[step % 16] + 12);

      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq * 1.2, time);
      osc.frequency.exponentialRampToValueAtTime(freq, time + 0.08);

      var form = ctx.createBiquadFilter();
      form.type = 'bandpass';
      form.frequency.value = 750;
      form.Q.value = 3;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.3);

      osc.connect(form);
      form.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.34);
    },

    /* Yeah — formant "ae" shout with a downward pitch bend. */
    yeah: function (time, row, step) {
      var freq = midiToFreq(oohline[step % 16] + 12);

      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq * 1.15, time);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.9, time + 0.12);

      var form = ctx.createBiquadFilter();
      form.type = 'bandpass';
      form.frequency.value = 1050;
      form.Q.value = 3;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.34);

      osc.connect(form);
      form.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.38);
    },

    /* Whistle — two detuned sines with vibrato, bright and piercing. */
    whistle: function (time, row, step) {
      var freq = midiToFreq(leadline[step % 16] + 24);

      var o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = freq * 1.003;

      var lfo = ctx.createOscillator();
      lfo.frequency.value = 6;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 8;
      lfo.connect(lfoGain);
      lfoGain.connect(o1.frequency);
      lfoGain.connect(o2.frequency);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.2, time + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.4);

      o1.connect(g);
      o2.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      lfo.start(time);
      o1.stop(time + 0.45);
      o2.stop(time + 0.45);
      lfo.stop(time + 0.45);
    },

    /* ======================================================================
       Kit 3 — World presets
       ====================================================================== */

    /* Congas — two pitched drums (low/high) alternating by step. */
    congas: function (time, row, step) {
      var seq = [57, 64, 57, 64]; // A2, E3
      var freq = midiToFreq(seq[step % 4]);

      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * 1.4, time);
      osc.frequency.exponentialRampToValueAtTime(freq, time + 0.04);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.6, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.18);

      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.22);
    },

    /* Cowbell — two square partials (540 + 800 Hz), very fast decay. */
    cowbell: function (time, row) {
      var o1 = ctx.createOscillator();
      o1.type = 'square';
      o1.frequency.value = 540;
      var o2 = ctx.createOscillator();
      o2.type = 'square';
      o2.frequency.value = 800;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.25, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.12);

      o1.connect(g);
      o2.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o1.stop(time + 0.15);
      o2.stop(time + 0.15);
    },

    /* Tambourine — noise burst + metallic jingle ring. */
    tambourine: function (time, row) {
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 5000;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.3, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.08);

      noise.connect(hp);
      hp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.1);

      // jingles: a few high sine pings
      for (var i = 0; i < 3; i++) {
        var j = ctx.createOscillator();
        j.type = 'sine';
        j.frequency.value = 6000 + Math.random() * 2000;
        var jg = ctx.createGain();
        jg.gain.setValueAtTime(0.08, time + i * 0.02);
        jg.gain.exponentialRampToValueAtTime(0.001, time + i * 0.02 + 0.06);
        j.connect(jg);
        connectRow(jg, row);
        j.start(time + i * 0.02);
        j.stop(time + i * 0.02 + 0.08);
      }
    },

    /* Pan Flute — breathy sine with vibrato and a soft attack. */
    panflute: function (time, row, step) {
      var freq = midiToFreq(leadline[step % 16] + 12);

      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;

      var lfo = ctx.createOscillator();
      lfo.frequency.value = 5.5;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 5;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.42, time + 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      lfo.start(time);
      osc.stop(time + 0.55);
      lfo.stop(time + 0.55);
    },

    /* Choir — saw through two formant bandpasses (vowel-ish pad). */
    choir: function (time, row, step) {
      var freq = midiToFreq(chantline[step % 16] + 12);

      var o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.value = freq * 1.004;

      var f1 = ctx.createBiquadFilter();
      f1.type = 'bandpass';
      f1.frequency.value = 500;
      f1.Q.value = 2;
      var f2 = ctx.createBiquadFilter();
      f2.type = 'bandpass';
      f2.frequency.value = 1100;
      f2.Q.value = 2;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.25, time + 0.08);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.6);

      o1.connect(f1);
      o2.connect(f1);
      f1.connect(f2);
      f2.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o1.stop(time + 0.65);
      o2.stop(time + 0.65);
    },

    /* Opera — formant "ah" with strong vibrato (soprano-ish). */
    opera: function (time, row, step) {
      var freq = midiToFreq(oohline[step % 16] + 24);

      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;

      var lfo = ctx.createOscillator();
      lfo.frequency.value = 5.8;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 9;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      var f1 = ctx.createBiquadFilter();
      f1.type = 'bandpass';
      f1.frequency.value = 800;
      f1.Q.value = 3;
      var f2 = ctx.createBiquadFilter();
      f2.type = 'bandpass';
      f2.frequency.value = 1150;
      f2.Q.value = 2;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.7);

      osc.connect(f1);
      f1.connect(f2);
      f2.connect(g);
      connectRow(g, row);
      osc.start(time);
      lfo.start(time);
      osc.stop(time + 0.75);
      lfo.stop(time + 0.75);
    },

    /* Djembe — pitched hand drum: low sine drop + a noise slap (like congas). */
    djembe: function (time, row, step) {
      var seq = [52, 57, 52, 60]; // E2, A2 (bass / slap tones)
      var freq = midiToFreq(seq[step % 4]);

      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * 1.8, time);
      osc.frequency.exponentialRampToValueAtTime(freq, time + 0.05);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.65, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.2);

      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.24);

      // noise slap on top (the "pa" of the stroke)
      var noise = noiseSource(time);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2200;
      bp.Q.value = 1.2;

      var ng = ctx.createGain();
      ng.gain.setValueAtTime(0.3, time);
      ng.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

      noise.connect(bp);
      bp.connect(ng);
      connectRow(ng, row);
      noise.stop(time + 0.07);
    },

    /* Rainstick — a cascade of tiny highpassed noise ticks (rain). */
    rainstick: function (time, row) {
      var count = 12 + Math.floor(Math.random() * 8); // 12-19 pops per hit
      var t = time;
      for (var i = 0; i < count; i++) {
        t += 0.008 + Math.random() * 0.03; // random-ish cascade spacing
        var noise = noiseSource(t);
        var hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 4000 + Math.random() * 3000;

        var g = ctx.createGain();
        g.gain.setValueAtTime(0.1 + Math.random() * 0.1, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.02);

        noise.connect(hp);
        hp.connect(g);
        connectRow(g, row);
        noise.stop(t + 0.03);
      }
    },

    /* ======================================================================
       Kit 4 — Circuit presets
       ====================================================================== */

    /* 808 Sub — pure sine, long sub drop. */
    sub808: function (time, row) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(120, time);
      osc.frequency.exponentialRampToValueAtTime(38, time + 0.3);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.85, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.7);

      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.75);
    },

    /* Crash — long bright noise wash. */
    crash: function (time, row) {
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 5000;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.4, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 1.2);

      noise.connect(hp);
      hp.connect(g);
      connectRow(g, row);
      noise.stop(time + 1.3);
    },

    /* Rimshot — sharp click: highpass noise + high sine ping. */
    rimshot: function (time, row) {
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3000;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.5, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.06);

      noise.connect(hp);
      hp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.08);

      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 1800;
      var og = ctx.createGain();
      og.gain.setValueAtTime(0.3, time);
      og.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
      osc.connect(og);
      connectRow(og, row);
      osc.start(time);
      osc.stop(time + 0.07);
    },

    /* Drum Glitch — stuttering noise bursts (rapid gain chops). */
    glitch: function (time, row) {
      var noise = noiseSource(time);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800;
      bp.Q.value = 1;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      var t = time;
      for (var i = 0; i < 8; i++) {
        g.gain.setValueAtTime(0.3, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
        t += 0.03;
      }

      noise.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      noise.stop(t + 0.02);
    },

    /* Filter Sweep — sweeps the master filter down and back (global FX) and
       adds an audible noise whoosh so the effect is heard on its own. */
    sweep: function (time) {
      if (!masterFilter) {
        return;
      }
      masterFilter.frequency.cancelScheduledValues(time);
      masterFilter.frequency.setValueAtTime(18000, time);
      masterFilter.frequency.exponentialRampToValueAtTime(350, time + 0.5);
      masterFilter.frequency.exponentialRampToValueAtTime(18000, time + 1.1);

      // audible whoosh: band-passed noise sweeping down with the filter
      var noise = noiseSource(time);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(6000, time);
      bp.frequency.exponentialRampToValueAtTime(300, time + 0.5);
      bp.Q.value = 1.2;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.08);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.6);
      noise.connect(bp);
      bp.connect(g);
      connectRow(g, 1);
      noise.stop(time + 0.65);
    },

    /* Sidechain — pumps the global gain down (ducking FX) and adds an
       audible pump tick so the effect is heard on its own. */
    sidechain: function (time) {
      if (!sidechainGain) {
        return;
      }
      sidechainGain.gain.cancelScheduledValues(time);
      sidechainGain.gain.setValueAtTime(1, time);
      sidechainGain.gain.setValueAtTime(0.3, time + 0.01);
      sidechainGain.gain.exponentialRampToValueAtTime(1, time + 0.3);

      // audible tick: short filtered noise burst
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1200;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.25, time + 0.005);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.12);
      noise.connect(hp);
      hp.connect(g);
      connectRow(g, 1);
      noise.stop(time + 0.15);
    },

    /* Synth Pad — detuned saws, slow attack, long release. */
    pad: function (time, row, step) {
      var freq = midiToFreq(leadline[step % 16] - 12);

      var o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.value = freq * 1.006;

      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1200;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.32, time + 0.25);
      g.gain.exponentialRampToValueAtTime(0.001, time + 1.4);

      o1.connect(lp);
      o2.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o1.stop(time + 1.5);
      o2.stop(time + 1.5);
    },

    /* Music Box — tiny sine ping with a sparkle overtone. */
    musicbox: function (time, row, step) {
      var freq = midiToFreq(arpline[step % 16] + 24);

      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = freq * 2;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.38, time + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

      var g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.0001, time);
      g2.gain.exponentialRampToValueAtTime(0.12, time + 0.004);
      g2.gain.exponentialRampToValueAtTime(0.001, time + 0.3);

      osc.connect(g);
      o2.connect(g2);
      connectRow(g, row);
      connectRow(g2, row);
      osc.start(time);
      o2.start(time);
      osc.stop(time + 0.55);
      o2.stop(time + 0.35);
    },

    /* Wobble Bass — saw through an LFO-modulated lowpass. */
    wobble: function (time, row, step) {
      var freq = midiToFreq(bassline[step % 16]);

      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;

      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 500;
      lp.Q.value = 8;

      var lfo = ctx.createOscillator();
      lfo.frequency.value = 8;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 400;
      lfo.connect(lfoGain);
      lfoGain.connect(lp.frequency);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.42, time + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.3);

      osc.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      osc.start(time);
      lfo.start(time);
      osc.stop(time + 0.34);
      lfo.stop(time + 0.34);
    },

    /* Strings — three detuned saws, slow attack pad. */
    strings: function (time, row, step) {
      var freq = midiToFreq(leadline[step % 16] - 12);

      var o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.value = freq * 1.008;
      var o3 = ctx.createOscillator();
      o3.type = 'sawtooth';
      o3.frequency.value = freq * 0.994;

      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1800;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.35, time + 0.15);
      g.gain.exponentialRampToValueAtTime(0.001, time + 1.1);

      o1.connect(lp);
      o2.connect(lp);
      o3.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o3.start(time);
      o1.stop(time + 1.2);
      o2.stop(time + 1.2);
      o3.stop(time + 1.2);
    },

    /* Talkbox — vocoder voice: detuned saws through a moving formant
       bandpass (the center frequency sweeps like a talking "wah"). */
    talkbox: function (time, row, step) {
      var freq = midiToFreq(talkboxline[step % 16]);

      var o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.value = freq * 1.006;

      var form = ctx.createBiquadFilter();
      form.type = 'bandpass';
      form.Q.value = 6;
      form.frequency.setValueAtTime(700, time);
      form.frequency.exponentialRampToValueAtTime(1400, time + 0.06);
      form.frequency.exponentialRampToValueAtTime(800, time + 0.16);

      var lfo = ctx.createOscillator();
      lfo.frequency.value = 5.5;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 4;
      lfo.connect(lfoGain);
      lfoGain.connect(o1.frequency);
      lfoGain.connect(o2.frequency);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.28, time + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.4);

      o1.connect(form);
      o2.connect(form);
      form.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      lfo.start(time);
      o1.stop(time + 0.45);
      o2.stop(time + 0.45);
      lfo.stop(time + 0.45);
    },

    /* ======================================================================
       Kit 5 — Jazz presets
       ====================================================================== */

    /* Jazz Kick — soft sine thump, lower and rounder than the origin kick. */
    jazzkick: function (time, row) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(120, time);
      osc.frequency.exponentialRampToValueAtTime(38, time + 0.12);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.7, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.3);

      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.34);
    },

    /* Ride — bright noise wash + two metallic pings (the "ding"). */
    ride: function (time, row) {
      var o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.value = 1800;
      var o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = 2700;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.16, time + 0.002);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

      o1.connect(g);
      o2.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o1.stop(time + 0.55);
      o2.stop(time + 0.55);

      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 6000;

      var ng = ctx.createGain();
      ng.gain.setValueAtTime(0.1, time);
      ng.gain.exponentialRampToValueAtTime(0.001, time + 0.18);

      noise.connect(hp);
      hp.connect(ng);
      connectRow(ng, row);
      noise.stop(time + 0.2);
    },

    /* Brushes — a soft swish: noise through a rising bandpass. */
    brushes: function (time, row) {
      var noise = noiseSource(time);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.2;
      bp.frequency.setValueAtTime(900, time);
      bp.frequency.exponentialRampToValueAtTime(3200, time + 0.12);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.22);

      noise.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.25);
    },

    /* Rim — sharp rim click: highpass noise + a short sine ping. */
    rim: function (time, row) {
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2500;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.45, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

      noise.connect(hp);
      hp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.07);

      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 1500;

      var og = ctx.createGain();
      og.gain.setValueAtTime(0.25, time);
      og.gain.exponentialRampToValueAtTime(0.001, time + 0.04);

      osc.connect(og);
      connectRow(og, row);
      osc.start(time);
      osc.stop(time + 0.06);
    },

    /* Splash — short bright noise wash with a few metallic pings. */
    splash: function (time, row) {
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 5500;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

      noise.connect(hp);
      hp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.55);

      for (var i = 0; i < 3; i++) {
        var o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.value = 4000 + Math.random() * 3000;
        var og = ctx.createGain();
        og.gain.setValueAtTime(0.08, time + i * 0.01);
        og.gain.exponentialRampToValueAtTime(0.001, time + i * 0.01 + 0.2);
        o.connect(og);
        connectRow(og, row);
        o.start(time + i * 0.01);
        o.stop(time + i * 0.01 + 0.25);
      }
    },

    /* Wah — muted trumpet: saw through a bandpass with a "wah" sweep. */
    wah: function (time, row, step) {
      var freq = midiToFreq(scatline[step % 16]);

      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;

      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 6;
      bp.frequency.setValueAtTime(500, time);
      bp.frequency.exponentialRampToValueAtTime(1800, time + 0.09);
      bp.frequency.exponentialRampToValueAtTime(600, time + 0.2);

var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.42, time + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.3);

      osc.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.34);
    },

    /* Walking Bass — plucked saw + sub sine walking a jazz bassline. */
    walking: function (time, row, step) {
      var freq = midiToFreq(jazzbass[step % 16]);

      var saw = ctx.createOscillator();
      saw.type = 'sawtooth';
      saw.frequency.value = freq;

      var sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = freq / 2;

      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(1200, time);
      lp.frequency.exponentialRampToValueAtTime(200, time + 0.18);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.5, time + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.3);

      saw.connect(lp);
      sub.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      saw.start(time);
      sub.start(time);
      saw.stop(time + 0.34);
      sub.stop(time + 0.34);
    },

    /* Comp — soft piano chord stabs (root + third + seventh per bar). */
    comp: function (time, row, step) {
      var bar = Math.floor(step / 4) % 4;
      var root = jazzcomp[bar];
      var shapes = [[0, 3, 7], [0, 4, 10], [0, 4, 10], [0, 4, 11]];
      var shape = shapes[bar];

      for (var i = 0; i < shape.length; i++) {
        var freq = midiToFreq(root + shape[i]);
        var osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;

        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, time);
        g.gain.exponentialRampToValueAtTime(0.24, time + 0.006);
        g.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

        osc.connect(g);
        connectRow(g, row);
        osc.start(time);
        osc.stop(time + 0.55);
      }
    },

    /* Sax — breathy saw with vibrato through a bandpass. */
    sax: function (time, row, step) {
      var freq = midiToFreq(saxline[step % 16]);

      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;

      var lfo = ctx.createOscillator();
      lfo.frequency.value = 5.5;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 6;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900;
      bp.Q.value = 2.5;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.42, time + 0.04);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.6);

      osc.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      osc.start(time);
      lfo.start(time);
      osc.stop(time + 0.65);
      lfo.stop(time + 0.65);

      // breath: a whisper of filtered noise
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2500;

      var ng = ctx.createGain();
      ng.gain.setValueAtTime(0.05, time);
      ng.gain.exponentialRampToValueAtTime(0.001, time + 0.4);

      noise.connect(hp);
      hp.connect(ng);
      connectRow(ng, row);
      noise.stop(time + 0.45);
    },

    /* Scat — formant "doo-ba": pitch bounces by step parity. */
    scat: function (time, row, step) {
      var freq = midiToFreq(scatline[step % 16]);

      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      if (step % 2 === 0) {
        // "doo" — pitch dips
        osc.frequency.setValueAtTime(freq * 1.1, time);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.95, time + 0.1);
      } else {
        // "ba" — pitch bounces up
        osc.frequency.setValueAtTime(freq * 0.9, time);
        osc.frequency.exponentialRampToValueAtTime(freq * 1.05, time + 0.08);
      }

      var form = ctx.createBiquadFilter();
      form.type = 'bandpass';
      form.frequency.value = step % 2 === 0 ? 700 : 1000;
      form.Q.value = 4;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.3);

      osc.connect(form);
      form.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.34);
    },

    /* Hum — soft sine with gentle vibrato, low volume. */
    hum: function (time, row, step) {
      var freq = midiToFreq(humline[step % 16]);

      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;

      var lfo = ctx.createOscillator();
      lfo.frequency.value = 5;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 3;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.08);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.6);

      osc.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      osc.start(time);
      lfo.start(time);
      osc.stop(time + 0.65);
      lfo.stop(time + 0.65);
    },

    /* Bop — short plosive "bop" syllable with a pitch snap. */
    bop: function (time, row, step) {
      var freq = midiToFreq(bopline[step % 16]);

      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq * 1.25, time);
      osc.frequency.exponentialRampToValueAtTime(freq, time + 0.05);

      var form = ctx.createBiquadFilter();
      form.type = 'bandpass';
      form.frequency.value = 1100;
      form.Q.value = 3;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.4, time + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.2);

      osc.connect(form);
      form.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.24);
    },

    /* ======================================================================
       Kit 6 — RNB presets
       ====================================================================== */

    /* RNB Kick — deep, soft sine thump (rounder than the origin kick). */
    rnbkick: function (time, row) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(130, time);
      osc.frequency.exponentialRampToValueAtTime(42, time + 0.12);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.9, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.32);

      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.36);
    },

    /* RNB Snare — softer noise + a short tonal body. */
    rnbsnare: function (time, row) {
      var noise = noiseSource(time);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1700;
      bp.Q.value = 0.8;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.6, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.18);

      noise.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.22);

      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(170, time);

      var og = ctx.createGain();
      og.gain.setValueAtTime(0.4, time);
      og.gain.exponentialRampToValueAtTime(0.001, time + 0.1);

      osc.connect(og);
      connectRow(og, row);
      osc.start(time);
      osc.stop(time + 0.13);
    },

    /* RNB Hi-Hat — crisp, short high-passed noise. */
    rnbhihat: function (time, row) {
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 8000;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.3, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

      noise.connect(hp);
      hp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.07);
    },

    /* RNB Rim — sharp rim click: highpass noise + a short sine ping. */
    rnbRim: function (time, row) {
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2800;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.4, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.05);

      noise.connect(hp);
      hp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.07);

      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 1600;

      var og = ctx.createGain();
      og.gain.setValueAtTime(0.22, time);
      og.gain.exponentialRampToValueAtTime(0.001, time + 0.04);

      osc.connect(og);
      connectRow(og, row);
      osc.start(time);
      osc.stop(time + 0.06);
    },

    /* RNB Shaker — soft, bright highpassed noise. */
    rnbshaker: function (time, row) {
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 5500;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.22, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.06);

      noise.connect(hp);
      hp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.08);
    },

    /* Crackle — vinyl crackle: a few random noise pops per hit. */
    crackle: function (time, row) {
      var count = 1 + Math.floor(Math.random() * 3);
      for (var i = 0; i < count; i++) {
        var t = time + Math.random() * 0.12;
        var noise = noiseSource(t);
        var hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 2000 + Math.random() * 3000;

        var g = ctx.createGain();
        g.gain.setValueAtTime(0.12 + Math.random() * 0.1, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);

        noise.connect(hp);
        hp.connect(g);
        connectRow(g, row);
        noise.stop(t + 0.05);
      }
    },

    /* Rhodes — bell-like sine + overtone with a slow tremolo. */
    rhodes: function (time, row, step) {
      var freq = midiToFreq(rhodesline[step % 16]);

      var o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = freq * 2;

      var trem = ctx.createGain();
      trem.gain.value = 1;
      var lfo = ctx.createOscillator();
      lfo.frequency.value = 5.5;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.35;
      lfo.connect(lfoGain);
      lfoGain.connect(trem.gain);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.42, time + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.7);

      o1.connect(trem);
      o2.connect(trem);
      trem.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      lfo.start(time);
      o1.stop(time + 0.75);
      o2.stop(time + 0.75);
      lfo.stop(time + 0.75);
    },

    /* Smooth Bass — round saw + sub sine through a closing lowpass. */
    smoothbass: function (time, row, step) {
      var freq = midiToFreq(rnbbass[step % 16]);

      var saw = ctx.createOscillator();
      saw.type = 'sawtooth';
      saw.frequency.value = freq;

      var sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = freq / 2;

      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(700, time);
      lp.frequency.exponentialRampToValueAtTime(160, time + 0.22);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.45, time + 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.3);

      saw.connect(lp);
      sub.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      saw.start(time);
      sub.start(time);
      saw.stop(time + 0.34);
      sub.stop(time + 0.34);
    },

    /* Guitar — plucked string: triangle through a fast-closing lowpass. */
    guitar: function (time, row, step) {
      var freq = midiToFreq(guitarline[step % 16]);

      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;

      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(2800, time);
      lp.frequency.exponentialRampToValueAtTime(600, time + 0.15);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.4, time + 0.005);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.4);

      osc.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.45);

      // pluck click
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2500;
      var ng = ctx.createGain();
      ng.gain.setValueAtTime(0.1, time);
      ng.gain.exponentialRampToValueAtTime(0.001, time + 0.02);
      noise.connect(hp);
      hp.connect(ng);
      connectRow(ng, row);
      noise.stop(time + 0.03);
    },

    /* Soul — warm formant voice: saw through two bandpasses with vibrato. */
    soul: function (time, row, step) {
      var freq = midiToFreq(soulline[step % 16]);

      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;

      var lfo = ctx.createOscillator();
      lfo.frequency.value = 5;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 5;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      var f1 = ctx.createBiquadFilter();
      f1.type = 'bandpass';
      f1.frequency.value = 600;
      f1.Q.value = 3;
      var f2 = ctx.createBiquadFilter();
      f2.type = 'bandpass';
      f2.frequency.value = 1200;
      f2.Q.value = 2;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.6);

      osc.connect(f1);
      f1.connect(f2);
      f2.connect(g);
      connectRow(g, row);
      osc.start(time);
      lfo.start(time);
      osc.stop(time + 0.65);
      lfo.stop(time + 0.65);
    },

    /* Adlib — short "hey" style shout with a pitch snap. */
    adlib: function (time, row, step) {
      var freq = midiToFreq(adlibline[step % 16]);

      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq * 1.2, time);
      osc.frequency.exponentialRampToValueAtTime(freq, time + 0.07);

      var form = ctx.createBiquadFilter();
      form.type = 'bandpass';
      form.frequency.value = 900;
      form.Q.value = 3;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.26, time + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.25);

      osc.connect(form);
      form.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.28);
    },

    /* RNB Ooh — soft sine pad voice with gentle vibrato. */
    rnbooh: function (time, row, step) {
      var freq = midiToFreq(rnboohline[step % 16]);

      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;

      var lfo = ctx.createOscillator();
      lfo.frequency.value = 4.5;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 3.5;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1300;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.28, time + 0.08);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.55);

      osc.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      osc.start(time);
      lfo.start(time);
      osc.stop(time + 0.6);
      lfo.stop(time + 0.6);
    },

    /* ======================================================================
       Kit 7 — Salsa presets
       ====================================================================== */

    /* Salsa Conga — two pitched drums (low/high) walking the tumbao groove. */
    saconga: function (time, row, step) {
      var seq = [55, 64, 55, 64]; // G2, E3
      var freq = midiToFreq(seq[step % 4]);

      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * 1.5, time);
      osc.frequency.exponentialRampToValueAtTime(freq, time + 0.05);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.7, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.2);

      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.24);
    },

    /* Timbales — bright metallic shell pings + a sharp noise tick. */
    satimbales: function (time, row) {
      var o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.value = 1900 + Math.random() * 300;
      var o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = 2850;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.003);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.3);

      o1.connect(g);
      o2.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o1.stop(time + 0.35);
      o2.stop(time + 0.35);

      var noise = noiseSource(time);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 4000;
      bp.Q.value = 1;

      var ng = ctx.createGain();
      ng.gain.setValueAtTime(0.18, time);
      ng.gain.exponentialRampToValueAtTime(0.001, time + 0.04);

      noise.connect(bp);
      bp.connect(ng);
      connectRow(ng, row);
      noise.stop(time + 0.06);
    },

    /* Bongo — two tiny high drums with a sharp slap (martillo feel). */
    sabongo: function (time, row, step) {
      var seq = [64, 69, 64, 71]; // E3, A3, E3, B3
      var freq = midiToFreq(seq[step % 4]);

      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq * 1.6, time);
      osc.frequency.exponentialRampToValueAtTime(freq, time + 0.035);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.55, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.12);

      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.15);
    },

    /* Clave — two wooden sticks: bandpassed noise + a woody partial. */
    saclav: function (time, row) {
      var noise = noiseSource(time);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1500;
      bp.Q.value = 2.5;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.5, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.08);

      noise.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.1);

      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1200, time);
      osc.frequency.exponentialRampToValueAtTime(500, time + 0.05);

      var og = ctx.createGain();
      og.gain.setValueAtTime(0.35, time);
      og.gain.exponentialRampToValueAtTime(0.001, time + 0.09);

      osc.connect(og);
      connectRow(og, row);
      osc.start(time);
      osc.stop(time + 0.12);
    },

    /* Guïro — scraped gourd: noise through a rising bandpass sweep. */
    saguiro: function (time, row) {
      var noise = noiseSource(time);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 3;
      bp.frequency.setValueAtTime(500, time);
      bp.frequency.exponentialRampToValueAtTime(2600, time + 0.12);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.16);

      noise.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.18);
    },

    /* Maracas — a shake: a few quick bright noise pops per hit. */
    samaracas: function (time, row) {
      var count = 2 + (Math.random() < 0.5 ? 1 : 0);
      for (var i = 0; i < count; i++) {
        var t = time + i * 0.02;
        var noise = noiseSource(t);
        var hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 5000 + Math.random() * 1500;

        var g = ctx.createGain();
        g.gain.setValueAtTime(0.18, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.04);

        noise.connect(hp);
        hp.connect(g);
        connectRow(g, row);
        noise.stop(t + 0.06);
      }
    },

    /* Campana — mambo bell: bright square partials with a long ring. */
    sacampana: function (time, row) {
      var o1 = ctx.createOscillator();
      o1.type = 'square';
      o1.frequency.value = 1150;
      var o2 = ctx.createOscillator();
      o2.type = 'square';
      o2.frequency.value = 1700;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.22, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.3);

      o1.connect(g);
      o2.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o1.stop(time + 0.34);
      o2.stop(time + 0.34);
    },

    /* Montuno — staccato piano pluck with a bright hammer click. */
    samontuno: function (time, row, step) {
      var freq = midiToFreq(montunoline[step % 16]);

      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.18);

      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.22);

      // hammer click
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3500;

      var ng = ctx.createGain();
      ng.gain.setValueAtTime(0.1, time);
      ng.gain.exponentialRampToValueAtTime(0.001, time + 0.015);

      noise.connect(hp);
      hp.connect(ng);
      connectRow(ng, row);
      noise.stop(time + 0.02);
    },

    /* Tumbao — salsa bass: saw + sub sine with the classic syncopation. */
    satumbao: function (time, row, step) {
      var freq = midiToFreq(tumbaoline[step % 16]);

      var saw = ctx.createOscillator();
      saw.type = 'sawtooth';
      saw.frequency.value = freq;

      var sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = freq / 2;

      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(900, time);
      lp.frequency.exponentialRampToValueAtTime(180, time + 0.2);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.4, time + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.28);

      saw.connect(lp);
      sub.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      saw.start(time);
      sub.start(time);
      saw.stop(time + 0.32);
      sub.stop(time + 0.32);
    },

    /* Trumpet — brass: saw + lowpass + vibrato, punchy attack. */
    satrum: function (time, row, step) {
      var freq = midiToFreq(trumpline[step % 16]);

      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;

      var lfo = ctx.createOscillator();
      lfo.frequency.value = 5.8;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 6;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(1800, time);
      lp.frequency.exponentialRampToValueAtTime(900, time + 0.25);
      lp.Q.value = 2;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

      osc.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      osc.start(time);
      lfo.start(time);
      osc.stop(time + 0.55);
      lfo.stop(time + 0.55);
    },

    /* Coro — choral chant: detuned saws through two formant bandpasses. */
    sacoro: function (time, row, step) {
      var freq = midiToFreq(coroline[step % 16]);

      var o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.value = freq * 1.005;

      var f1 = ctx.createBiquadFilter();
      f1.type = 'bandpass';
      f1.frequency.value = 550;
      f1.Q.value = 2.5;
      var f2 = ctx.createBiquadFilter();
      f2.type = 'bandpass';
      f2.frequency.value = 1150;
      f2.Q.value = 2;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.26, time + 0.07);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.6);

      o1.connect(f1);
      o2.connect(f1);
      f1.connect(f2);
      f2.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o1.stop(time + 0.65);
      o2.stop(time + 0.65);
    },

    /* Soneo — lead vocal: formant "ay" with a pitch snap and vibrato. */
    sasoneo: function (time, row, step) {
      var freq = midiToFreq(soneoline[step % 16]);

      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(freq * 1.12, time);
      osc.frequency.exponentialRampToValueAtTime(freq, time + 0.09);

      var lfo = ctx.createOscillator();
      lfo.frequency.value = 5.2;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 5;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      var f1 = ctx.createBiquadFilter();
      f1.type = 'bandpass';
      f1.frequency.value = 700;
      f1.Q.value = 3;
      var f2 = ctx.createBiquadFilter();
      f2.type = 'bandpass';
      f2.frequency.value = 1250;
      f2.Q.value = 2;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.45);

      osc.connect(f1);
      f1.connect(f2);
      f2.connect(g);
      connectRow(g, row);
      osc.start(time);
      lfo.start(time);
      osc.stop(time + 0.5);
      lfo.stop(time + 0.5);
    },

    /* ======================================================================
       Gold combos (Wave 4) — Salsa Brass changes with the company it keeps
       ====================================================================== */

    /* Combo: the beats are in — Brass fires punchy rhythmic stabs. */
    satrumGoldBeat: function (time, row, step) {
      var freq = midiToFreq(60 + (step % 4) * 3);
      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;

      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900;
      bp.Q.value = 3;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.18);

      osc.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.22);
    },

    /* Combo: the melodies are in — Brass carries a bright sustained phrase. */
    satrumGoldMelody: function (time, row, step) {
      var freq = midiToFreq(trumpline[step % 16] + 12);

      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;

      var lfo = ctx.createOscillator();
      lfo.frequency.value = 5.5;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 6;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1200;
      bp.Q.value = 2;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.7);

      osc.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      osc.start(time);
      lfo.start(time);
      osc.stop(time + 0.75);
      lfo.stop(time + 0.75);
    },

    /* Combo: the voices are in — Brass doubles into a detuned growl. */
    satrumGoldVoice: function (time, row, step) {
      var freq = midiToFreq(trumpline[step % 16] + 12);
      var o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.value = freq * 1.007; // detuned growl

      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1000;
      bp.Q.value = 2.5;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.26, time + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

      o1.connect(bp);
      o2.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o1.stop(time + 0.55);
      o2.stop(time + 0.55);

      // breath layer
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2000;
      var ng = ctx.createGain();
      ng.gain.setValueAtTime(0.04, time);
      ng.gain.exponentialRampToValueAtTime(0.001, time + 0.45);
      noise.connect(hp);
      hp.connect(ng);
      connectRow(ng, row);
      noise.stop(time + 0.5);
    },

    /* ======================================================================
       Gold combos (Wave 4) — Zap changes sound with the company it keeps
       ====================================================================== */

    /* Combo: the core beat is in — Zap becomes a laser riding the groove. */
    zapGoldBeat: function (time, row, step) {
      var freq = midiToFreq(60 + (step % 4) * 3);
      var osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(freq * 2, time);
      osc.frequency.exponentialRampToValueAtTime(freq, time + 0.08);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.25, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.12);

      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.14);
    },

    /* Combo: the melodies are in — Zap becomes a sparkle arp. */
    zapGoldMelody: function (time, row, step) {
      var freq = midiToFreq(arpline[step % 16] + 24);
      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.2, time + 0.006);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.18);

      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.2);
    },

    /* Combo: the voices are in — Zap becomes a robotic voice zap. */
    zapGoldVoice: function (time, row, step) {
      var freq = midiToFreq(chantline[step % 16] + 12);
      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;

      var form = ctx.createBiquadFilter();
      form.type = 'bandpass';
      form.frequency.value = 900;
      form.Q.value = 5;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.25, time + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.25);

      osc.connect(form);
      form.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.28);
    },

    /* ======================================================================
       Gold combos (Wave 4) — Chant changes with the company it keeps
       ====================================================================== */

    /* Combo: the beat crew is in — Chant locks into a staccato rhythm chant. */
    chantGoldBeat: function (time, row, step) {
      var freq = midiToFreq(57 + (step % 4) * 2);
      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;

      var form = ctx.createBiquadFilter();
      form.type = 'bandpass';
      form.frequency.value = 600 + (step % 4) * 150;
      form.Q.value = 4;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.26, time + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.18);

      osc.connect(form);
      form.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.22);
    },

    /* Combo: the melodies are in — Chant swells into a long harmonic phrase. */
    chantGoldMelody: function (time, row, step) {
      var freq = midiToFreq(chantline[step % 16] + 12);
      var o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.value = freq * 1.004;

      var f1 = ctx.createBiquadFilter();
      f1.type = 'bandpass';
      f1.frequency.value = 520;
      f1.Q.value = 2.5;
      var f2 = ctx.createBiquadFilter();
      f2.type = 'bandpass';
      f2.frequency.value = 1150;
      f2.Q.value = 2;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.28, time + 0.09);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.7);

      o1.connect(f1);
      o2.connect(f1);
      f1.connect(f2);
      f2.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o1.stop(time + 0.75);
      o2.stop(time + 0.75);
    },

    /* Combo: the voices are in — Chant becomes a bright two-voice shout. */
    chantGoldVoice: function (time, row, step) {
      var freq = midiToFreq(chantline[step % 16] + 24);
      var o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.value = freq * 1.5; // fifth above — shouting harmony

      var lfo = ctx.createOscillator();
      lfo.frequency.value = 6;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 5;
      lfo.connect(lfoGain);
      lfoGain.connect(o1.frequency);
      lfoGain.connect(o2.frequency);

      var form = ctx.createBiquadFilter();
      form.type = 'bandpass';
      form.frequency.value = 1000;
      form.Q.value = 3;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.26, time + 0.04);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

      o1.connect(form);
      o2.connect(form);
      form.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      lfo.start(time);
      o1.stop(time + 0.55);
      o2.stop(time + 0.55);
      lfo.stop(time + 0.55);
    },

    /* ======================================================================
       Gold combos (Wave 4) — Whistle changes with the company it keeps
       ====================================================================== */

    /* Combo: the beat crew is in — Whistle fires short rhythmic blips. */
    whistleGoldBeat: function (time, row, step) {
      var freq = midiToFreq(72 + (step % 4) * 2);
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.18, time + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.14);

      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.16);
    },

    /* Combo: the melodies are in — Whistle carries a long bright melody. */
    whistleGoldMelody: function (time, row, step) {
      var freq = midiToFreq(leadline[step % 16] + 24);
      var o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = freq * 1.003;

      var lfo = ctx.createOscillator();
      lfo.frequency.value = 6.5;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 7;
      lfo.connect(lfoGain);
      lfoGain.connect(o1.frequency);
      lfoGain.connect(o2.frequency);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.22, time + 0.04);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.6);

      o1.connect(g);
      o2.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      lfo.start(time);
      o1.stop(time + 0.65);
      o2.stop(time + 0.65);
      lfo.stop(time + 0.65);
    },

    /* Combo: the voices are in — Whistle does a quick rising "tweet-tweet". */
    whistleGoldVoice: function (time, row, step) {
      var base = midiToFreq(76 + (step % 4) * 3);
      for (var i = 0; i < 2; i++) {
        var f = base * (i === 0 ? 1 : 1.26);
        var osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f * 1.1, time + i * 0.05);
        osc.frequency.exponentialRampToValueAtTime(f, time + i * 0.05 + 0.04);

        var g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, time + i * 0.05);
        g.gain.exponentialRampToValueAtTime(0.18, time + i * 0.05 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.001, time + i * 0.05 + 0.16);

        osc.connect(g);
        connectRow(g, row);
        osc.start(time + i * 0.05);
        osc.stop(time + i * 0.05 + 0.18);
      }
    },

    /* ======================================================================
       Gold combos (Wave 4) — Pan Flute changes with the company it keeps
       ====================================================================== */

    /* Combo: the beats are in — Pan Flute plays short rhythmic stabs. */
    panfluteGoldBeat: function (time, row, step) {
      var freq = midiToFreq(60 + (step % 4) * 3);
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.24, time + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.22);

      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.26);
    },

    /* Combo: the effects are in — Pan Flute goes hollow with a low fifth. */
    panfluteGoldFX: function (time, row, step) {
      var freq = midiToFreq(leadline[step % 16] + 7);
      var o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = freq * 1.5; // hollow fifth

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.2, time + 0.06);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

      o1.connect(g);
      o2.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o1.stop(time + 0.55);
      o2.stop(time + 0.55);
    },

    /* Combo: the voices are in — Pan Flute becomes a high airy duet. */
    panfluteGoldVoice: function (time, row, step) {
      var freq = midiToFreq(leadline[step % 16] + 19);
      var o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = freq * 1.005;

      var lfo = ctx.createOscillator();
      lfo.frequency.value = 5.8;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 6;
      lfo.connect(lfoGain);
      lfoGain.connect(o1.frequency);
      lfoGain.connect(o2.frequency);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.24, time + 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.65);

      o1.connect(g);
      o2.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      lfo.start(time);
      o1.stop(time + 0.7);
      o2.stop(time + 0.7);
      lfo.stop(time + 0.7);
    },

    /* ======================================================================
       Gold combos (Wave 4) — Sax changes with the company it keeps
       ====================================================================== */

    /* Combo: the beats are in — Sax plays punchy short stabs. */
    saxGoldBeat: function (time, row, step) {
      var freq = midiToFreq(57 + (step % 4) * 3);
      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;

      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 800;
      bp.Q.value = 3;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.26, time + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.2);

      osc.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.24);
    },

    /* Combo: the melodies are in — Sax plays a smooth sustained phrase. */
    saxGoldMelody: function (time, row, step) {
      var freq = midiToFreq(saxline[step % 16]);
      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;

      var lfo = ctx.createOscillator();
      lfo.frequency.value = 5.5;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 6;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);

      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1100;
      bp.Q.value = 2;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.28, time + 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.7);

      osc.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      osc.start(time);
      lfo.start(time);
      osc.stop(time + 0.75);
      lfo.stop(time + 0.75);
    },

    /* Combo: the voices are in — Sax doubles into a detuned growl. */
    saxGoldVoice: function (time, row, step) {
      var freq = midiToFreq(saxline[step % 16] + 12);
      var o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.value = freq * 1.007; // detuned growl

      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 950;
      bp.Q.value = 2.5;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.24, time + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.5);

      o1.connect(bp);
      o2.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o1.stop(time + 0.55);
      o2.stop(time + 0.55);

      // breath layer
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2000;
      var ng = ctx.createGain();
      ng.gain.setValueAtTime(0.04, time);
      ng.gain.exponentialRampToValueAtTime(0.001, time + 0.45);
      noise.connect(hp);
      hp.connect(ng);
      connectRow(ng, row);
      noise.stop(time + 0.5);
    },

    /* ======================================================================
       Gold combos (Wave 4) — Rhodes changes with the company it keeps
       ====================================================================== */

    /* Combo: the beats are in — Rhodes plays rhythmic staccato plinks. */
    rhodesGoldBeat: function (time, row, step) {
      var freq = midiToFreq(57 + (step % 4) * 2);
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = freq * 2;

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.24, time + 0.006);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.22);

      var g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.0001, time);
      g2.gain.exponentialRampToValueAtTime(0.08, time + 0.006);
      g2.gain.exponentialRampToValueAtTime(0.001, time + 0.16);

      osc.connect(g);
      o2.connect(g2);
      connectRow(g, row);
      connectRow(g2, row);
      osc.start(time);
      o2.start(time);
      osc.stop(time + 0.26);
      o2.stop(time + 0.2);
    },

    /* Combo: the melodies are in — Rhodes plays a long dreamy phrase. */
    rhodesGoldMelody: function (time, row, step) {
      var freq = midiToFreq(rhodesline[step % 16]);
      var o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = freq * 2;

      var trem = ctx.createGain();
      trem.gain.value = 1;
      var lfo = ctx.createOscillator();
      lfo.frequency.value = 4.5;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.3;
      lfo.connect(lfoGain);
      lfoGain.connect(trem.gain);

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.28, time + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.9);

      o1.connect(trem);
      o2.connect(trem);
      trem.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      lfo.start(time);
      o1.stop(time + 0.95);
      o2.stop(time + 0.95);
      lfo.stop(time + 0.95);
    },

    /* Combo: the voices are in — Rhodes shimmers with a soulful fifth. */
    rhodesGoldVoice: function (time, row, step) {
      var freq = midiToFreq(rhodesline[step % 16] + 12);
      var o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = freq * 1.5; // fifth shimmer

      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.24, time + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.6);

      o1.connect(g);
      o2.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o1.stop(time + 0.65);
      o2.stop(time + 0.65);
    },

    /* ======================================================================
       Kit 8 — BOSSA NOVA presets
       Identity: acoustic warmth — nylon plucks, brush drums, upright bass,
       soft jazz chords, breathy vocals. Everything warm (lowpass), soft
       (low gain), with gentle attacks and long decays.
       ====================================================================== */

    /* Bossa Kick — soft round kick, gentle pitch drop, low gain. */
    bossakick: function (time, row) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(100, time);
      osc.frequency.exponentialRampToValueAtTime(45, time + 0.14);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.55, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.35);
      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.4);
    },

    /* Bossa Snare — brush snare: soft noise through a LOWPASS (the brush
       swish), no harsh bandpass, plus a warm tonal body. */
    bossasnare: function (time, row) {
      var noise = noiseSource(time);
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1400;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.4, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.32);
      noise.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.36);
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(160, time);
      var og = ctx.createGain();
      og.gain.setValueAtTime(0.25, time);
      og.gain.exponentialRampToValueAtTime(0.001, time + 0.2);
      osc.connect(og);
      connectRow(og, row);
      osc.start(time);
      osc.stop(time + 0.24);
    },

    /* Bossa Shaker — soft samba shaker, gentle high-passed noise. */
    bossashaker: function (time, row) {
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 5500;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.12, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.1);
      noise.connect(hp);
      hp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.12);
    },

    /* Tamborim — small high-pitched Brazilian drum, soft. */
    tamborim: function (time, row) {
      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(850, time);
      osc.frequency.exponentialRampToValueAtTime(480, time + 0.09);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.3, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.14);
      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.17);
    },

    /* Bossa Guitar — nylon strum: triangle pluck + a whisper of noise,
       warm lowpass, quick decay (acoustic feel). */
    bossaguitar: function (time, row, step) {
      var notes = [45, 48, 52, 50, 48, 45, 43, 45, 48, 52, 55, 52, 48, 50, 48, 45];
      var freq = midiToFreq(notes[step % 16]);
      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1500;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.28, time + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.22);
      osc.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.25);
      var noise = noiseSource(time);
      var ng = ctx.createGain();
      ng.gain.setValueAtTime(0.05, time);
      ng.gain.exponentialRampToValueAtTime(0.001, time + 0.08);
      noise.connect(ng);
      connectRow(ng, row);
      noise.stop(time + 0.1);
    },

    /* Pandeiro — Brazilian tambourine, noise + jingle. */
    pandeiro: function (time, row) {
      var noise = noiseSource(time);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2800;
      bp.Q.value = 1.0;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.3, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.16);
      noise.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.2);
      var osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.setValueAtTime(1100, time);
      var og = ctx.createGain();
      og.gain.setValueAtTime(0.1, time);
      og.gain.exponentialRampToValueAtTime(0.001, time + 0.09);
      osc.connect(og);
      connectRow(og, row);
      osc.start(time);
      osc.stop(time + 0.11);
    },

    /* Agogô — two-tone bell, alternates high/low, soft. */
    agogo: function (time, row, step) {
      var freq = (step % 2 === 0) ? 830 : 620;
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.005);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.32);
      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.36);
    },

    /* Bossa Piano — soft jazz chords: root + fifth together, warm lowpass,
       slow attack (comping feel). */
    bossapiano: function (time, row, step) {
      var freq = midiToFreq(bossapianoline[step % 16]);
      var o1 = ctx.createOscillator();
      o1.type = 'triangle';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'triangle';
      o2.frequency.value = freq * 1.5; // fifth
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1800;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.26, time + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.55);
      o1.connect(lp);
      o2.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o1.stop(time + 0.6);
      o2.stop(time + 0.6);
    },

    /* Bossa Sax — soft tenor: saw + formant + slow vibrato, low gain. */
    bossasax: function (time, row, step) {
      var freq = midiToFreq(bossasaxline[step % 16]);
      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      var form = ctx.createBiquadFilter();
      form.type = 'bandpass';
      form.frequency.value = 650;
      form.Q.value = 2.5;
      var lfo = ctx.createOscillator();
      lfo.frequency.value = 4;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 2.5;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.2, time + 0.06);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.55);
      osc.connect(form);
      form.connect(g);
      connectRow(g, row);
      osc.start(time);
      lfo.start(time);
      osc.stop(time + 0.6);
      lfo.stop(time + 0.6);
    },

    /* Bossa Bass — upright acoustic bass: sine with a soft pluck attack. */
    bossabass: function (time, row, step) {
      var freq = midiToFreq(bossabassline[step % 16]);
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.4, time + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.32);
      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.36);
    },

    /* Bossa Voice — breathy whisper: sine + formant + vibrato, very soft. */
    bossavoice: function (time, row, step) {
      var freq = midiToFreq(bossavoiceline[step % 16]);
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      var form = ctx.createBiquadFilter();
      form.type = 'bandpass';
      form.frequency.value = 850;
      form.Q.value = 2.5;
      var lfo = ctx.createOscillator();
      lfo.frequency.value = 4.5;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 2;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.16, time + 0.1);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.55);
      osc.connect(form);
      form.connect(g);
      connectRow(g, row);
      osc.start(time);
      lfo.start(time);
      osc.stop(time + 0.6);
      lfo.stop(time + 0.6);
    },

    /* Bossa Choir — soft "ahh": three detuned sines, slow attack. */
    bossachoir: function (time, row, step) {
      var freq = midiToFreq(bossachoirline[step % 16]);
      var o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = freq * 1.5;
      var o3 = ctx.createOscillator();
      o3.type = 'sine';
      o3.frequency.value = freq * 2;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.18, time + 0.12);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.65);
      o1.connect(g);
      o2.connect(g);
      o3.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o3.start(time);
      o1.stop(time + 0.7);
      o2.stop(time + 0.7);
      o3.stop(time + 0.7);
    },

    /* ======================================================================
       Kit 9 — KPOP presets
       Identity: bright production — punchy kick with click, layered claps,
       wide detuned saw leads, processed vocals, dramatic risers/drops.
       Everything bright (highpass/high filters), punchy (fast attack).
       ====================================================================== */

    /* K-Kick — punchy pop kick: sine pitch drop + square body + click. */
    kpopkick: function (time, row) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(170, time);
      osc.frequency.exponentialRampToValueAtTime(45, time + 0.09);
      var g = ctx.createGain();
      g.gain.setValueAtTime(1.0, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.22);
      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.26);
      var body = ctx.createOscillator();
      body.type = 'square';
      body.frequency.setValueAtTime(220, time);
      body.frequency.exponentialRampToValueAtTime(90, time + 0.05);
      var bg = ctx.createGain();
      bg.gain.setValueAtTime(0.3, time);
      bg.gain.exponentialRampToValueAtTime(0.001, time + 0.07);
      body.connect(bg);
      connectRow(bg, row);
      body.start(time);
      body.stop(time + 0.09);
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3000;
      var ng = ctx.createGain();
      ng.gain.setValueAtTime(0.25, time);
      ng.gain.exponentialRampToValueAtTime(0.001, time + 0.03);
      noise.connect(hp);
      hp.connect(ng);
      connectRow(ng, row);
      noise.stop(time + 0.05);
    },

    /* K-Snare — bright pop snare: bright noise + high snap + body. */
    kpopsnare: function (time, row) {
      var noise = noiseSource(time);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2600;
      bp.Q.value = 0.6;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.9, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.15);
      noise.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.19);
      var snap = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 5000;
      var sg = ctx.createGain();
      sg.gain.setValueAtTime(0.4, time);
      sg.gain.exponentialRampToValueAtTime(0.001, time + 0.05);
      snap.connect(hp);
      hp.connect(sg);
      connectRow(sg, row);
      snap.stop(time + 0.07);
      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(240, time);
      var og = ctx.createGain();
      og.gain.setValueAtTime(0.5, time);
      og.gain.exponentialRampToValueAtTime(0.001, time + 0.08);
      osc.connect(og);
      connectRow(og, row);
      osc.start(time);
      osc.stop(time + 0.11);
    },

    /* K-HiHat — bright fast hi-hat with a metallic shimmer ping. */
    kophihat: function (time, row) {
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 9000;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.28, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.045);
      noise.connect(hp);
      hp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.06);
      var ping = ctx.createOscillator();
      ping.type = 'sine';
      ping.frequency.value = 9500;
      var pg = ctx.createGain();
      pg.gain.setValueAtTime(0.12, time);
      pg.gain.exponentialRampToValueAtTime(0.001, time + 0.03);
      ping.connect(pg);
      connectRow(pg, row);
      ping.start(time);
      ping.stop(time + 0.05);
    },

    /* K-Clap — layered clap with more presence. */
    kpopclap: function (time, row) {
      for (var i = 0; i < 3; i++) {
        var t = time + i * 0.011;
        var noise = noiseSource(t);
        var bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1600;
        bp.Q.value = 1.2;
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.55, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.11);
        noise.connect(bp);
        bp.connect(g);
        connectRow(g, row);
        noise.stop(t + 0.14);
      }
    },

    /* Riser K — epic rising sweep: saw + noise, bright (one-shot). */
    kpopriser: function (time, row) {
      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(250, time);
      osc.frequency.exponentialRampToValueAtTime(2500, time + 0.9);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(400, time);
      bp.frequency.exponentialRampToValueAtTime(5000, time + 0.9);
      bp.Q.value = 1.5;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.8);
      g.gain.exponentialRampToValueAtTime(0.001, time + 1.0);
      osc.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 1.05);
      var noise = noiseSource(time);
      var ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, time);
      ng.gain.exponentialRampToValueAtTime(0.15, time + 0.85);
      ng.gain.exponentialRampToValueAtTime(0.001, time + 1.0);
      noise.connect(ng);
      connectRow(ng, row);
      noise.stop(time + 1.05);
    },

    /* Drop FX — impact: noise burst + sub thump (one-shot). */
    kpopdrop: function (time, row) {
      var noise = noiseSource(time);
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(4500, time);
      lp.frequency.exponentialRampToValueAtTime(200, time + 0.4);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.85, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.5);
      noise.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.55);
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(130, time);
      osc.frequency.exponentialRampToValueAtTime(40, time + 0.3);
      var og = ctx.createGain();
      og.gain.setValueAtTime(0.85, time);
      og.gain.exponentialRampToValueAtTime(0.001, time + 0.4);
      osc.connect(og);
      connectRow(og, row);
      osc.start(time);
      osc.stop(time + 0.45);
    },

    /* Synth FX — bright electronic blip. */
    kpopsynthfx: function (time, row, step) {
      var freq = midiToFreq(62 + (step % 4) * 3);
      var osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1500;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.2, time + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.09);
      osc.connect(hp);
      hp.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.12);
    },

    /* K-Synth Lead — bright pop supersaw: 3 wide-detuned saws + square octave. */
    kppsynth: function (time, row, step) {
      var freq = midiToFreq(kppsynthline[step % 16]);
      var o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.value = freq * 1.02;
      var o3 = ctx.createOscillator();
      o3.type = 'sawtooth';
      o3.frequency.value = freq * 0.98;
      var sq = ctx.createOscillator();
      sq.type = 'square';
      sq.frequency.value = freq * 2;
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(6000, time);
      lp.frequency.exponentialRampToValueAtTime(1800, time + 0.16);
      lp.Q.value = 1.2;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.28, time + 0.006);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.24);
      o1.connect(lp);
      o2.connect(lp);
      o3.connect(lp);
      sq.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o3.start(time);
      sq.start(time);
      o1.stop(time + 0.28);
      o2.stop(time + 0.28);
      o3.stop(time + 0.28);
      sq.stop(time + 0.28);
    },

    /* K-Piano — bright pop piano with a bell overtone. */
    kpoppiano: function (time, row, step) {
      var freq = midiToFreq(kpoppianoline[step % 16]);
      var o1 = ctx.createOscillator();
      o1.type = 'triangle';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'triangle';
      o2.frequency.value = freq * 2;
      var bell = ctx.createOscillator();
      bell.type = 'sine';
      bell.frequency.value = freq * 4;
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 400;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.32, time + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.28);
      o1.connect(hp);
      o2.connect(hp);
      bell.connect(hp);
      hp.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      bell.start(time);
      o1.stop(time + 0.32);
      o2.stop(time + 0.32);
      bell.stop(time + 0.32);
    },

    /* K-Bass — synth-pop square bass: punchy, fast attack (NOT a saw bass). */
    kpopbass: function (time, row, step) {
      var freq = midiToFreq(kpopbassline[step % 16]);
      var osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;
      var sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = freq;
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.45, time + 0.005);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.22);
      osc.connect(lp);
      sub.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      osc.start(time);
      sub.start(time);
      osc.stop(time + 0.26);
      sub.stop(time + 0.26);
    },

    /* K-Vocal — processed K-pop vocal: TWO detuned saws + bright formant. */
    kpopvocal: function (time, row, step) {
      var freq = midiToFreq(kpopvocalline[step % 16]);
      var o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.value = freq * 1.01;
      var form = ctx.createBiquadFilter();
      form.type = 'bandpass';
      form.frequency.value = 1400;
      form.Q.value = 2;
      var lfo = ctx.createOscillator();
      lfo.frequency.value = 6.5;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 5;
      lfo.connect(lfoGain);
      lfoGain.connect(o1.frequency);
      lfoGain.connect(o2.frequency);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.04);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.38);
      o1.connect(form);
      o2.connect(form);
      form.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      lfo.start(time);
      o1.stop(time + 0.42);
      o2.stop(time + 0.42);
      lfo.stop(time + 0.42);
    },

    /* K-Chant — "Hey! Yeah!" processed shout. */
    kpopchant: function (time, row, step) {
      var freq = midiToFreq(kpopchantline[step % 16] + 12);
      var osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1400;
      bp.Q.value = 1.8;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.28, time + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.18);
      osc.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.22);
    },

    /* ======================================================================
       Kit 10 — TRAP presets
       Identity: dark 808 — deep sub-bass with long decays, heavy snare,
       fast thin hi-hats, dark minor melodies, short ad-libs.
       ====================================================================== */

    /* 808 Kick — deep sub-bass kick, LONG decay (the 808 signature). */
    '808kick': function (time, row) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(110, time);
      osc.frequency.exponentialRampToValueAtTime(35, time + 0.18);
      var g = ctx.createGain();
      g.gain.setValueAtTime(1.0, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.55);
      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.6);
    },

    /* Trap Snare — heavy snare with roll. */
    trapsnare: function (time, row) {
      var noise = noiseSource(time);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1900;
      bp.Q.value = 0.6;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.95, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.28);
      noise.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.32);
      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(185, time);
      var og = ctx.createGain();
      og.gain.setValueAtTime(0.55, time);
      og.gain.exponentialRampToValueAtTime(0.001, time + 0.14);
      osc.connect(og);
      connectRow(og, row);
      osc.start(time);
      osc.stop(time + 0.17);
    },

    /* Trap HiHat — fast thin hi-hat. */
    traphihat: function (time, row) {
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 8000;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.22, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.04);
      noise.connect(hp);
      hp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.06);
    },

    /* Trap Clap — dry aggressive clap. */
    trapclap: function (time, row) {
      for (var i = 0; i < 3; i++) {
        var t = time + i * 0.009;
        var noise = noiseSource(t);
        var bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1300;
        bp.Q.value = 1.0;
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.65, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
        noise.connect(bp);
        bp.connect(g);
        connectRow(g, row);
        noise.stop(t + 0.12);
      }
    },

    /* Hi-Hat Roll — fast roll of hi-hats. */
    traproll: function (time, row) {
      for (var i = 0; i < 5; i++) {
        var t = time + i * 0.025;
        var noise = noiseSource(t);
        var hp = ctx.createBiquadFilter();
        hp.type = 'highpass';
        hp.frequency.value = 7500;
        var g = ctx.createGain();
        g.gain.setValueAtTime(0.18, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
        noise.connect(hp);
        hp.connect(g);
        connectRow(g, row);
        noise.stop(t + 0.05);
      }
    },

    /* Trap Riser — dark rising sweep (one-shot). */
    trapriser: function (time, row) {
      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(80, time);
      osc.frequency.exponentialRampToValueAtTime(1000, time + 0.9);
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(150, time);
      lp.frequency.exponentialRampToValueAtTime(2500, time + 0.9);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.8);
      g.gain.exponentialRampToValueAtTime(0.001, time + 1.0);
      osc.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 1.05);
    },

    /* Trap FX — urban sweep. */
    trapfx: function (time, row) {
      var noise = noiseSource(time);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(350, time);
      bp.frequency.exponentialRampToValueAtTime(1800, time + 0.3);
      bp.Q.value = 3;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.4, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.4);
      noise.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.45);
    },

    /* Trap Synth — dark melodic synth: detuned saws + sub octave. */
    trapsynth: function (time, row, step) {
      var freq = midiToFreq(trapsynthline[step % 16]);
      var o1 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'sawtooth';
      o2.frequency.value = freq * 1.008;
      var sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.value = freq * 0.5;
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(1200, time);
      lp.frequency.exponentialRampToValueAtTime(350, time + 0.3);
      lp.Q.value = 4;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.42);
      o1.connect(lp);
      o2.connect(lp);
      sub.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      sub.start(time);
      o1.stop(time + 0.46);
      o2.stop(time + 0.46);
      sub.stop(time + 0.46);
    },

    /* Trap Piano — dark minor piano. */
    trappiano: function (time, row, step) {
      var freq = midiToFreq(trappianoline[step % 16]);
      var o1 = ctx.createOscillator();
      o1.type = 'triangle';
      o1.frequency.value = freq;
      var o2 = ctx.createOscillator();
      o2.type = 'triangle';
      o2.frequency.value = freq * 2;
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1500;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.3, time + 0.005);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.42);
      o1.connect(lp);
      o2.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o1.stop(time + 0.46);
      o2.stop(time + 0.46);
    },

    /* Trap Bass — 808 with slide: long sub-bass decay. */
    trapbass: function (time, row, step) {
      var freq = midiToFreq(trapbassline[step % 16]);
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, time);
      osc.frequency.exponentialRampToValueAtTime(freq * 1.5, time + 0.25);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.5, time + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.5);
      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.55);
    },

    /* Trap Vocals — short processed ad-libs. */
    trapvocal: function (time, row, step) {
      var freq = midiToFreq(trapvocalline[step % 16] + 12);
      var osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      var form = ctx.createBiquadFilter();
      form.type = 'bandpass';
      form.frequency.value = 1000;
      form.Q.value = 2;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.25, time + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.16);
      osc.connect(form);
      form.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.2);
    },

    /* ======================================================================
       Kit 11 — LOFI presets
       Identity: dusty nostalgia — detuned mellow piano, vinyl crackle,
       tape hiss, soft beats, rain. Everything lowpassed, slightly
       out-of-tune, with long decays (reverb feel).
       ====================================================================== */

    /* Lo-Fi Kick — soft round kick, lowpassed. */
    lofikick: function (time, row) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(100, time);
      osc.frequency.exponentialRampToValueAtTime(42, time + 0.13);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.6, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.35);
      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.4);
    },

    /* Lo-Fi Snare — dusty snare: noise through LOWPASS, long decay. */
    lofisnare: function (time, row) {
      var noise = noiseSource(time);
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1200;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.45, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.4);
      noise.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.45);
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(155, time);
      var og = ctx.createGain();
      og.gain.setValueAtTime(0.25, time);
      og.gain.exponentialRampToValueAtTime(0.001, time + 0.22);
      osc.connect(og);
      connectRow(og, row);
      osc.start(time);
      osc.stop(time + 0.26);
    },

    /* Lo-Fi HiHat — soft hissy hi-hat. */
    lofihihat: function (time, row) {
      var noise = noiseSource(time);
      var hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 6000;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.12, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.09);
      noise.connect(hp);
      hp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.11);
    },

    /* Vinyl Crackle — random vinyl crackle. */
    loficrackle: function (time, row) {
      var noise = noiseSource(time);
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2500;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.14, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.12);
      noise.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.14);
    },

    /* Rain — soft background rain, filtered noise. */
    lofirain: function (time, row) {
      var noise = noiseSource(time);
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1500;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.12, time + 0.06);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.35);
      noise.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.4);
    },

    /* Tape Hiss — magnetic tape noise. */
    lofitape: function (time, row) {
      var noise = noiseSource(time);
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2200;
      bp.Q.value = 0.4;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.1, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.14);
      noise.connect(bp);
      bp.connect(g);
      connectRow(g, row);
      noise.stop(time + 0.17);
    },

    /* Vinyl Pop — random vinyl pop (one-shot). */
    lofipop: function (time, row) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1100, time);
      osc.frequency.exponentialRampToValueAtTime(350, time + 0.06);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.18, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.09);
      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.11);
    },

    /* Lo-Fi Piano — DETUNED mellow piano (the lo-fi signature), long decay. */
    lofipiano: function (time, row, step) {
      var freq = midiToFreq(lofipianoline[step % 16]);
      var o1 = ctx.createOscillator();
      o1.type = 'triangle';
      o1.frequency.value = freq * 0.98; // warped
      var o2 = ctx.createOscillator();
      o2.type = 'triangle';
      o2.frequency.value = freq * 1.01; // warped
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1600;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.28, time + 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.65);
      o1.connect(lp);
      o2.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o1.stop(time + 0.7);
      o2.stop(time + 0.7);
    },

    /* Lo-Fi Guitar — soft nostalgic guitar, warm. */
    lofiguitar: function (time, row, step) {
      var freq = midiToFreq(lofiguitarline[step % 16]);
      var osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq * 0.99;
      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1400;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.22, time + 0.006);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.32);
      osc.connect(lp);
      lp.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.36);
    },

    /* Lo-Fi Bass — round acoustic bass, soft. */
    lofibass: function (time, row, step) {
      var freq = midiToFreq(lofibassline[step % 16]);
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.4, time + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.38);
      osc.connect(g);
      connectRow(g, row);
      osc.start(time);
      osc.stop(time + 0.42);
    },

    /* Lo-Fi Vocal — soft "ahh": three detuned sines, reverb feel. */
    lofivocal: function (time, row, step) {
      var freq = midiToFreq(lofivocalline[step % 16]);
      var o1 = ctx.createOscillator();
      o1.type = 'sine';
      o1.frequency.value = freq * 0.99;
      var o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.value = freq * 1.5;
      var o3 = ctx.createOscillator();
      o3.type = 'sine';
      o3.frequency.value = freq * 1.01;
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.18, time + 0.12);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.7);
      o1.connect(g);
      o2.connect(g);
      o3.connect(g);
      connectRow(g, row);
      o1.start(time);
      o2.start(time);
      o3.start(time);
      o1.stop(time + 0.75);
      o2.stop(time + 0.75);
      o3.stop(time + 0.75);
    }
  };

  /* ------------------------- scheduler ----------------------------------- */

  // One-shot characters fire on click only; they never loop in the mix.
  function isOneShot(ch) {
    return !!ch.oneShot;
  }

  // Wave 4: gold characters swap their synth when a secret combo is active.
  function goldComboFor(ch) {
    if (!ch.goldCombos) {
      return null;
    }
    for (var i = 0; i < ch.goldCombos.length; i++) {
      var combo = ch.goldCombos[i];
      var ok = true;
      for (var j = 0; j < combo.ids.length; j++) {
        // Skip the character's own id: a gold character is always "active"
        // while it plays, so a self-referencing combo would always match.
        if (combo.ids[j] !== ch.id && !active[combo.ids[j]]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        return combo;
      }
    }
    return null;
  }

  // Wave 4: energy = how full the mix is (0..1). At max an extra FX unlocks.
  function energyLevel() {
    var count = 0;
    for (var id in active) {
      if (Object.prototype.hasOwnProperty.call(active, id)) {
        count++;
      }
    }
    return Math.min(1, count / ENERGY_MAX);
  }

  // Wave 4: call & response — the first active melody answers a beat hit
  // with a note on the off-beat (half a step later, different note).
  function callResponse(stepIndex, time) {
    for (var id in active) {
      if (!Object.prototype.hasOwnProperty.call(active, id)) {
        continue;
      }
      var ch = charById(id);
      if (!ch || ch.row !== 2 || isOneShot(ch)) {
        continue;
      }
      if (ch.pattern.charAt(stepIndex) !== '.') {
        continue; // already playing here — no response needed
      }
      // Only sparse melodies answer the beats. Dense patterns (8+ hits per
      // bar) already fill the groove; adding half-step responses makes them
      // sound glitchy.
      var hits = 0;
      for (var i = 0; i < ch.pattern.length; i++) {
        if (ch.pattern.charAt(i) !== '.') {
          hits++;
        }
      }
      if (hits > 4) {
        continue;
      }
      var fn = synths[ch.synth];
      if (fn) {
        panForStep = panForChar(ch, stepIndex);
        fn(time + stepDuration() * 0.5, ch.row, (stepIndex + stepsPerBar / 2) % stepsPerBar);
      }
      break; // one responder is enough
    }
  }

  // Wave 3: on the last bar of each fill cycle, roll through the kit's
  // beat characters on the second half of the bar.
  function fillStep(stepIndex, time) {
    var bar = Math.floor(step / stepsPerBar);
    if (bar % FILL_EVERY !== FILL_EVERY - 1) {
      return;
    }
    if (FILL_PATTERN.charAt(stepIndex) !== 'X') {
      return;
    }
    var beats = [];
    for (var i = 0; i < currentKit.characters.length; i++) {
      var c = currentKit.characters[i];
      if (c.row === 0 && !isOneShot(c)) {
        beats.push(c);
      }
    }
    if (beats.length === 0) {
      return;
    }
    var pick = beats[stepIndex % beats.length];
    var fn = synths[pick.synth];
    if (fn) {
      panForStep = panForChar(pick, stepIndex);
      fn(time, 0, stepIndex);
    }
  }

  function scheduleStep(stepIndex, time) {
    if (PlayMusikAudio.onStep) {
      PlayMusikAudio.onStep(stepIndex, time);
    }

    var beatFired = false;

    for (var id in active) {
      if (!Object.prototype.hasOwnProperty.call(active, id)) {
        continue;
      }
      var ch = charById(id);
      if (!ch) {
        continue;
      }
      if (isOneShot(ch)) {
        continue; // one-shots fire on click, not in the loop
      }

      // Wave 4: probability gate — each cycle the note may not sound.
      if (probOn[id] && Math.random() > (ch.prob || 0.5)) {
        continue;
      }

      var pattern = ch.pattern;
      var playTime = time;
      var synthId = ch.synth;

      // Wave 4: ghost notes duplicate another character's pattern with a
      // micro-delay (and their own, softer sound).
      if (ch.ghostOf) {
        var target = charById(ch.ghostOf);
        if (!target) {
          continue;
        }
        pattern = target.pattern;
        playTime = time + (ch.ghostDelay || 0.03);
      }

      // Any non-rest char fires: 'X'/'x' = hit, 'o' = accent, 'g' = ghost
      // stroke, 'f' = fill. All are treated as hits by the scheduler.
      if (pattern.charAt(stepIndex) === '.') {
        continue;
      }

      // Wave 4: gold characters change sound with secret combos.
      if (ch.gold) {
        var combo = goldComboFor(ch);
        if (combo) {
          synthId = combo.synth;
        }
      }

      var fn = synths[synthId];
      if (fn) {
        panForStep = panForChar(ch, stepIndex);
        fn(playTime, ch.row, stepIndex);
        if (ch.row === 0) {
          beatFired = true;
        }
      }
    }

    // Wave 4: melodies answer the beats.
    if (beatFired) {
      callResponse(stepIndex, time);
    }

    // Wave 3: auto-fill.
    if (autoFill) {
      fillStep(stepIndex, time);
    }
  }

  // Called every TICK_MS: schedule everything within the lookahead window.
  function tick() {
    if (!playing || !ctx) {
      return;
    }
    var ahead = ctx.currentTime + LOOKAHEAD_MS / 1000;
    while (nextStepTime < ahead) {
      try {
        scheduleStep(step % stepsPerBar, nextStepTime);
      } catch (err) {
        // A single broken synth must never freeze the whole scheduler.
        // Log and keep the loop running; the offending character just
        // stays silent for this step.
        if (window.console && console.error) {
          console.error('Play Musik scheduler step error:', err);
        }
      }
      nextStepTime += stepDuration();
      step++;
    }
  }

  /* ------------------------- transport ----------------------------------- */

  function start() {
    if (!data || playing || !ctx) {
      return;
    }
    playing = true;
    step = 0;
    nextStepTime = ctx.currentTime + 0.06; // small grace period for a clean start
    timerId = setInterval(tick, TICK_MS);
    tick();
  }

  function stop() {
    playing = false;
    if (timerId !== null) {
      clearInterval(timerId);
      timerId = null;
    }
    step = 0;
    nextStepTime = 0;
    if (PlayMusikAudio.onStep) {
      PlayMusikAudio.onStep(-1, 0); // UI clears the step indicator
    }
  }

  function toggle() {
    if (playing) {
      stop();
    } else {
      ensure();
      start();
    }
  }

  // One-shot preview of a single character (used on click).
  function playOnce(charId) {
    if (!ctx) {
      return;
    }
    var ch = charById(charId);
    if (!ch) {
      return;
    }
    var fn = synths[ch.synth];
    if (fn) {
      fn(ctx.currentTime + 0.02, ch.row, 0);
    }
  }

  // Wave 3: an "accent" hit — the character fires twice a few ms apart
  // (a flam), which reads as a harder, emphasized strike while holding.
  function playAccent(charId) {
    if (!ctx) {
      return;
    }
    var ch = charById(charId);
    if (!ch) {
      return;
    }
    var fn = synths[ch.synth];
    if (!fn) {
      return;
    }
    var t = ctx.currentTime + 0.02;
    fn(t, ch.row, 0);
    fn(t + 0.05, ch.row, 1);
  }

  /* ------------------------- public API ---------------------------------- */

  var PlayMusikAudio = {
    init: function (d) {
      data = d;
      currentKit = d.kits[0];
      bpm = d.bpm || 100;
    },
    setKit: function (kitId) {
      for (var i = 0; i < data.kits.length; i++) {
        if (data.kits[i].id === kitId) {
          currentKit = data.kits[i];
          active = {}; // armed characters belong to the previous kit
          return true;
        }
      }
      return false;
    },
    getKitId: function () {
      return currentKit ? currentKit.id : null;
    },
    ensure: ensure,
    playOnce: playOnce,
    playAccent: playAccent,
    setAutoFill: function (on) {
      autoFill = !!on;
    },
    getAutoFill: function () {
      return autoFill;
    },
    start: start,
    stop: stop,
    toggle: toggle,
    isPlaying: function () {
      return playing;
    },
    setBpm: function (v) {
      bpm = v;
    },
    getBpm: function () {
      return bpm;
    },
    setTimeSignature: function (sig) {
      stepsPerBar = (sig === '3/4' ? 12 : sig === '2/4' ? 8 : 16);
    },
    getTimeSignature: function () {
      return stepsPerBar === 12 ? '3/4' : stepsPerBar === 8 ? '2/4' : '4/4';
    },
    setActive: function (charId, on) {
      if (on) {
        active[charId] = true;
      } else {
        delete active[charId];
      }
    },
    setProb: function (charId, on) {
      if (on) {
        probOn[charId] = true;
      } else {
        delete probOn[charId];
      }
    },
    getEnergy: function () {
      return energyLevel();
    },
    setRowMuted: function (row, m) {
      rowMuted[row] = m;
      if (rowGains[row]) {
        rowGains[row].gain.value = m ? 0 : rowVolume[row];
      }
    },
    setRowVolume: function (row, v) {
      rowVolume[row] = v;
      if (rowGains[row]) {
        rowGains[row].gain.value = rowMuted[row] ? 0 : v;
      }
    },
    onStep: null // UI hook: onStep(stepIndex, audioTime); stepIndex -1 = stopped
  };

  return PlayMusikAudio;
})();
