/* ==========================================================================
   Play Musik — i18n.js
   Lightweight internationalization layer: zh (default) / en / es.

   - t(key, vars)   translate a key; falls back to en, then to the key itself
   - setLang(lang)  switch language and persist under 'musiclike-lang'
   - getLang()      read the persisted language (default 'zh')
   - applyI18n()    re-apply translations to [data-i18n] (textContent),
                    [data-i18n-title] (title) and [data-i18n-aria]
                    (aria-label) elements, then fire PlayMusikI18n.onApply
                    so main.js can re-render dynamic strings.

   Classic script loaded between audio-engine.js and main.js.
   ========================================================================== */

'use strict';

var PlayMusikI18n = (function () {
  var STORAGE_KEY = 'musiclike-lang';
  var DEFAULT_LANG = 'zh';

  var DICTS = {
    zh: {
      'play': '播放',
      'stop': '停止',
      'bpm': 'BPM',
      'random': '随机',
      'panic': '清空',
      'autoFill': '自动加花',
      'energy': '能量',
      'settings': '设置',
      'credits': '致谢',
      'changeLanguage': '切换语言',
      'close': '关闭',
      'back': '返回',
      'language': '语言',
      'languages': 'Languages',
      'sounds': '个音色',
      'row.beats': '节拍',
      'row.effects': '效果',
      'row.melodies': '旋律',
      'row.voices': '人声',
      'char.toggle': '点击切换加入/移出混音',
      'char.oneShot': '单次触发：点击播放一次',
      'char.ghost': '幽灵：以微延迟回响 {name}',
      'prob.title': '概率：每个循环有 {pct}% 的几率播放音符',
      'credits.title': '致谢',
      'credits.body': 'Play Musik 是一款完全离线的节拍制作应用。所有声音均在浏览器中实时合成，无需联网。',
      'lang.zh': '中文',
      'lang.en': 'English',
      'lang.es': 'Español',
      'timeSig': '拍号',
      'mute': '静音',
      'unmute': '取消静音',
      'volume': '音量',
      'aria.kits': '音色套件',
      'aria.characters': '角色',
      'bpm.aria': '每分钟节拍数（BPM）',
      'random.title': '随机混音——随机激活一组角色',
      'panic.title': '清空——移除所有角色并停止',
      'autoFill.title': '自动加花——每 4 小节插入鼓花',
      'energy.title': '能量表——填满可解锁额外特效',
      'home': '主页',
      'home.title': '主页——了解 Play Musik',
      'home.start': '开始创作音乐',
      'home.intro1': '我做这个应用，是为了不用学作曲也能做音乐。',
      'home.intro2': '我不会乐器，也不懂乐理。但我热爱创作。',
      'home.inspiration': '灵感来源',
      'home.habbo': '我从小玩到大。最吸引我的是 WIRED 家具——它是可视化编程：连接积木，东西就会动。它让我在不知不觉中学会了逻辑。',
      'home.incredibox': '我小时候就很喜欢它。一直好奇它内部是怎么运作的。',
      'home.how': '它是怎么来的',
      'home.how1': '我看到了小红书上的 vibecoding 比赛。规则：100% 离线，纯 HTML/CSS/JS。我想：“我有个想法。那就真的把它做出来吧。”',
      'home.how2': '于是我做了自己的 Incredibox 版本。用合成音效。完全离线。',
      'home.problem': '问题',
      'home.problem1': '我试过自己录音。失败了。零音乐训练。',
      'home.problem2': '所以我用 Web Audio API 合成一切——底鼓、军鼓、旋律，全部用代码。没有音频文件，没有采样。它成功了。',
      'home.quote1': '7 个套件。79 种音色。全部离线。',
      'home.quote2': '点击一个角色。它会发出声音。声音循环播放。你就能做出节拍。',
      'home.quote3': '没有账号。没有广告。没有网络。只有像素和音乐。',
      'home.share': '为什么要分享？',
      'home.share1': '小红书给了我一个完成的理由。而创意不应该依赖 Wi-Fi。',
      'home.sign': '—— 在夜晚和周末完成。只有代码。',
      'home.author': '作者：ELVIS ENRIQUE CHEN QIU —— 巴拿马',
      'home.license': '基于 MIT 许可证开源',
      'credits.linkedin': '领英：',
      'credits.github': 'GitHub：',
      'credits.date': '交付日期：2026年9月7日',
      'credits.author': '作者：ELVIS ENRIQUE CHEN QIU —— 巴拿马',
      'credits.license': '基于 MIT 许可证授权——可自由使用、修改和分享。'
    },

    en: {
      'play': 'Play',
      'stop': 'Stop',
      'bpm': 'BPM',
      'random': 'Random',
      'panic': 'Panic',
      'autoFill': 'Auto-Fill',
      'energy': 'Energy',
      'settings': 'Settings',
      'credits': 'Credits',
      'changeLanguage': 'Change language',
      'close': 'Close',
      'back': 'Back',
      'language': 'Language',
      'languages': 'Languages',
      'sounds': 'sounds',
      'row.beats': 'Beats',
      'row.effects': 'Effects',
      'row.melodies': 'Melodies',
      'row.voices': 'Voices',
      'char.toggle': 'click to toggle in/out of the mix',
      'char.oneShot': 'one-shot: click to fire it once',
      'char.ghost': 'ghost: echoes {name} with a micro-delay',
      'prob.title': 'Probability: notes play with a {pct}% chance each cycle',
      'credits.title': 'Credits',
      'credits.body': 'Play Musik is a fully offline beat-making app. All sounds are synthesized live in your browser.',
      'lang.zh': '中文',
      'lang.en': 'English',
      'lang.es': 'Español',
      'timeSig': 'Time signature',
      'mute': 'Mute',
      'unmute': 'Unmute',
      'volume': 'volume',
      'aria.kits': 'Sound kits',
      'aria.characters': 'Characters',
      'bpm.aria': 'Tempo in beats per minute',
      'random.title': 'Random mix — activate a random set of characters',
      'panic.title': 'Panic — clear every character and stop',
      'autoFill.title': 'Auto-fill — insert a drum fill every 4 bars',
      'energy.title': 'Energy meter — fill it to max to unlock an extra FX',
      'home': 'Home',
      'home.title': 'Home — learn about Play Musik',
      'home.start': 'Start Making Music',
      'home.intro1': 'I made this so I could make music without learning how to compose.',
      'home.intro2': "I don't play instruments. I don't know music theory. But I love creating.",
      'home.inspiration': 'The inspiration',
      'home.habbo': "I grew up on it. What hooked me was the WIRED furniture. It's visual programming — connect blocks, things move. It taught me logic without me realizing it.",
      'home.incredibox': 'I loved it as a kid. Always wondered how it worked under the hood.',
      'home.how': 'How it happened',
      'home.how1': 'I saw the vibecoding competition on Xiaohongshu. Rules: 100% offline, pure HTML/CSS/JS. I thought: "I have an idea. Let me actually build it."',
      'home.how2': 'So I built my own version of Incredibox. With synthetic sounds. Offline.',
      'home.problem': 'The problem',
      'home.problem1': 'I tried recording my own sounds. Failed. Zero musical training.',
      'home.problem2': 'So I used the Web Audio API to synthesize everything — kick drums, snares, melodies, all with code. No audio files. No samples. It worked.',
      'home.quote1': '7 kits. 79 sounds. All offline.',
      'home.quote2': 'Click a character. They make a sound. The sound loops. You build a beat.',
      'home.quote3': 'No account. No ads. No internet. Just pixels and music.',
      'home.share': 'Why share it?',
      'home.share1': "Xiaohongshu gave me a reason to finish. And creativity shouldn't require Wi-Fi.",
      'home.sign': '— Built on nights and weekends. Just code.',
      'home.author': 'Made by ELVIS ENRIQUE CHEN QIU — Panama',
      'home.license': 'Open source under the MIT License',
      'credits.linkedin': 'LinkedIn:',
      'credits.github': 'GitHub:',
      'credits.date': 'Delivery date: September 7, 2026',
      'credits.author': 'Author: ELVIS ENRIQUE CHEN QIU — Panama',
      'credits.license': 'Licensed under the MIT License — free to use, modify and share.'
    },

    es: {
      'play': 'Reproducir',
      'stop': 'Detener',
      'bpm': 'BPM',
      'random': 'Aleatorio',
      'panic': 'Pánico',
      'autoFill': 'Relleno auto',
      'energy': 'Energía',
      'settings': 'Ajustes',
      'credits': 'Créditos',
      'changeLanguage': 'Cambiar idioma',
      'close': 'Cerrar',
      'back': 'Atrás',
      'language': 'Idioma',
      'languages': 'Languages',
      'sounds': 'sonidos',
      'row.beats': 'Ritmos',
      'row.effects': 'Efectos',
      'row.melodies': 'Melodías',
      'row.voices': 'Voces',
      'char.toggle': 'clic para incluir o excluir de la mezcla',
      'char.oneShot': 'one-shot: clic para dispararlo una vez',
      'char.ghost': 'fantasma: repite {name} con un micro-retardo',
      'prob.title': 'Probabilidad: las notas suenan con un {pct}% de probabilidad en cada ciclo',
      'credits.title': 'Créditos',
      'credits.body': 'Play Musik es una app de creación de ritmos totalmente offline. Todos los sonidos se sintetizan en vivo en tu navegador.',
      'lang.zh': '中文',
      'lang.en': 'English',
      'lang.es': 'Español',
      'timeSig': 'Compás',
      'mute': 'Silenciar',
      'unmute': 'Reactivar',
      'volume': 'volumen',
      'aria.kits': 'Kits de sonido',
      'aria.characters': 'Personajes',
      'bpm.aria': 'Tempo en pulsaciones por minuto',
      'random.title': 'Mezcla aleatoria: activa un conjunto aleatorio de personajes',
      'panic.title': 'Pánico: elimina todos los personajes y detén',
      'autoFill.title': 'Relleno automático: inserta un relleno de batería cada 4 compases',
      'energy.title': 'Medidor de energía: llénalo al máximo para desbloquear un FX extra',
      'home': 'Inicio',
      'home.title': 'Inicio — conoce Play Musik',
      'home.start': 'Empezar a crear música',
      'home.intro1': 'Hice esto para poder hacer música sin aprender a componer.',
      'home.intro2': 'No toco instrumentos. No sé teoría musical. Pero me encanta crear.',
      'home.inspiration': 'La inspiración',
      'home.habbo': 'Crecí con él. Lo que me enganchó fueron los muebles WIRED. Es programación visual: conectas bloques y las cosas se mueven. Me enseñó lógica sin que me diera cuenta.',
      'home.incredibox': 'Me encantaba de niño. Siempre me pregunté cómo funcionaba por dentro.',
      'home.how': 'Cómo pasó',
      'home.how1': 'Vi el concurso de vibecoding en Xiaohongshu. Reglas: 100% offline, HTML/CSS/JS puro. Pensé: "Tengo una idea. Vamos a construirla de verdad."',
      'home.how2': 'Así que construí mi propia versión de Incredibox. Con sonidos sintetizados. Offline.',
      'home.problem': 'El problema',
      'home.problem1': 'Intenté grabar mis propios sonidos. Fallé. Cero formación musical.',
      'home.problem2': 'Así que usé la Web Audio API para sintetizarlo todo: bombos, cajas, melodías, todo con código. Sin archivos de audio. Sin samples. Funcionó.',
      'home.quote1': '7 kits. 79 sonidos. Todo offline.',
      'home.quote2': 'Haz clic en un personaje. Hace un sonido. El sonido se repite. Construyes un beat.',
      'home.quote3': 'Sin cuenta. Sin anuncios. Sin internet. Solo píxeles y música.',
      'home.share': '¿Por qué compartirlo?',
      'home.share1': 'Xiaohongshu me dio una razón para terminarlo. Y la creatividad no debería necesitar Wi-Fi.',
      'home.sign': '— Hecho en noches y fines de semana. Solo código.',
      'home.author': 'Hecho por ELVIS ENRIQUE CHEN QIU — Panamá',
      'home.license': 'Código abierto bajo licencia MIT',
      'credits.linkedin': 'LinkedIn:',
      'credits.github': 'GitHub:',
      'credits.date': 'Fecha de entrega: 7 de septiembre de 2026',
      'credits.author': 'Autor: ELVIS ENRIQUE CHEN QIU — Panamá',
      'credits.license': 'Licenciado bajo MIT — libre de usar, modificar y compartir.'
    }
  };

  var current = getLang();

  function normalize(lang) {
    return DICTS[lang] ? lang : DEFAULT_LANG;
  }

  function getLang() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved && DICTS[saved]) {
        return saved;
      }
    } catch (err) {
      // storage unavailable (private mode, file:// restrictions) — default
    }
    return DEFAULT_LANG;
  }

  function setLang(lang) {
    current = normalize(lang);
    try {
      localStorage.setItem(STORAGE_KEY, current);
    } catch (err) {
      // storage unavailable — in-memory only
    }
    return current;
  }

  function t(key, vars) {
    var dict = DICTS[current] || {};
    var str = dict[key];
    if (str === undefined) {
      str = DICTS.en[key];
    }
    if (str === undefined) {
      str = key;
    }
    if (vars && typeof str === 'string') {
      str = str.replace(/\{(\w+)\}/g, function (m, name) {
        return vars[name] !== undefined ? String(vars[name]) : m;
      });
    }
    return str;
  }

  function applyI18n() {
    if (document.documentElement) {
      document.documentElement.lang = current;
    }

    var els = document.querySelectorAll('[data-i18n]');
    for (var i = 0; i < els.length; i++) {
      els[i].textContent = t(els[i].getAttribute('data-i18n'));
    }

    var titles = document.querySelectorAll('[data-i18n-title]');
    for (var j = 0; j < titles.length; j++) {
      titles[j].setAttribute('title', t(titles[j].getAttribute('data-i18n-title')));
    }

    var arias = document.querySelectorAll('[data-i18n-aria]');
    for (var k = 0; k < arias.length; k++) {
      arias[k].setAttribute('aria-label', t(arias[k].getAttribute('data-i18n-aria')));
    }

    if (typeof PlayMusikI18n.onApply === 'function') {
      PlayMusikI18n.onApply();
    }
  }

  return {
    t: t,
    setLang: setLang,
    getLang: getLang,
    applyI18n: applyI18n,
    DEFAULT_LANG: DEFAULT_LANG
  };
})();