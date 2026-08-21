# Play Musik 🎵

Un beat-maker estilo **Incredibox** construido con HTML, CSS y JavaScript puro. Haz click en los personajes para activar loops y mezclar un beat. **100% offline** — todos los sonidos se sintetizan en tu navegador con la Web Audio API, sin ninguna conexión a internet.

## Características

### Kits (11 kits, 125 personajes)

- **Origin** (12): el equipo clásico — Kick, Snare, Hi-Hat / Scratch, Boom, Zap / Bass, Lead, Arp / Chant, Beatbox, Ooh.
- **Neon** (12): la crew eléctrica — Toms, Clap, Shaker / Air Horn, Vinyl Scratch, Riser / Piano, Pluck, Chiptune / Hey, Yeah, Whistle.
- **World** (8): percusión orgánica y voces — Congas, Cowbell, Tambourine / Djembe, Rainstick / Pan Flute / Choir, Opera.
- **Circuit** (11): toolkit electrónico — 808 Sub, Crash, Rimshot / Drum Glitch, Filter Sweep, Sidechain / Synth Pad, Music Box, Wobble Bass, Strings / Talkbox.
- **Jazz** (12): la crew nocturna — Ride, Brushes, Kick / Rim, Splash, Wah / Walking Bass, Comp, Sax / Scat, Hum, Bop.
- **RNB** (12): grooves suaves — Kick, Snare, Hi-Hat / Rim, Shaker, Crackle / Rhodes, Smooth Bass, Guitar / Soul, Adlib, Ooh.
- **Salsa** (12): la crew latina — Congas, Timbales, Bongo, Clave / Güiro, Maracas, Campana / Montuno, Tumbao, Brass / Coro, Soneo.
- **BOSSA NOVA** (12): calidez acústica brasileña — Kick, Brush, Shaker, Tamborim / Guitarra, Pandeiro, Agogô / Piano, Sax, Bajo / Voz, Coro.
- **KPOP** (12): producción brillante — Kick, Snare, Hi-Hat, Clap / Riser, Drop, FX / Synth Lead, Piano, Bass / Vocal, Chant.
- **TRAP** (11): 808 oscuro y pesado — 808, Snare, Hi-Hat, Clap / Roll, Riser, FX / Synth, Piano, Bass / Adlibs.
- **LOFI** (11): nostalgia polvorienta — Kick, Snare, Hi-Hat, Vinyl / Rain, Tape, Pop / Piano, Guitarra, Bass / Vocal.

Cada personaje tiene su **patrón rítmico** (16 pasos) y su propio **sonido sintetizado** (Web Audio API, cero archivos de audio).

### Comportamientos dinámicos

- **One-shot**: Toms, Air Horn, Riser, Crash, Splash y los risers/drops de KPOP/TRAP suenan una sola vez al hacer click (nunca entran al loop).
- **Intensidad**: mantén pulsado un personaje para disparar un acento extra (flam).
- **Random**: activa una mezcla aleatoria de personajes.
- **Probabilidad**: cada personaje con badge `P` puede activar su puerta aleatoria — sus notas suenan con X% de probabilidad por ciclo.
- **Ghost Notes**: Shaker (eco de Clap) y Tambourine (eco de Congas) duplican el patrón de otro personaje con un micro-delay.
- **Call & Response**: las melodías responden rítmicamente a los beats activos.
- **Gold Character**: Zap, Chant, Whistle, Pan Flute, Sax, Rhodes y Brass (★) cambian su sonido según combos secretos de personajes activos.
- **Auto-pan**: Hi-Hat, Arp, Shaker, Tambourine, Music Box y otros alternan L/R; Congas, Cowbell y Strings tienen posición fija.

### Transporte y mezcla

- Play/Stop, slider de **BPM** (60–180), indicador de pasos visual.
- **Mute y volumen por fila** + master.
- **Filter Sweep** y **Sidechain** modulan nodos globales de la cadena de audio.
- Estado persistido en `localStorage` (personajes activos, probabilidades, auto-fill, BPM, filas).
- Accesibilidad básica: `aria-pressed`, `aria-label`, teclado (espacio para Play/Stop).

## Cómo ejecutarlo

No requiere instalación, build ni servidor. Dos opciones:

1. **Directo**: abre `index.html` en el navegador (funciona desde `file://`).
2. **Local**: sirve la carpeta con cualquier servidor estático, p. ej.:
   ```
   python -m http.server 8000
   ```
   y abre `http://localhost:8000`.

## Cómo usarlo

1. Elige un **kit** en la barra superior (Origin / Neon / World / Circuit / Jazz / RNB / Salsa / BOSSA NOVA / KPOP / TRAP / LOFI).
2. Haz click en un personaje para activarlo (vuelve a hacer click para silenciarlo). Los one-shot suenan al click.
3. Pulsa **Play** (o la barra espaciadora) para que los loops suenen sincronizados.
4. Ajusta el **BPM** para cambiar la velocidad.
5. Usa **mute/volumen** del panel lateral de cada fila para mezclar.
6. Prueba **Random**, los badges **P** (probabilidad) y los personajes **★** (combos secretos).

## Estructura del proyecto

```
index.html                Entrada de la app (logo, grid, transport, Home, modal de ajustes)
src/
  css/styles.css          Estilos: identidad visual, grid, animaciones, Home
  js/data.js              Config de los 11 kits y 125 personajes (nombre, fila, patrón, synth, flags)
  js/audio-engine.js      Motor de audio: síntesis Web Audio + scheduler + FX globales
  js/i18n.js              Traducciones zh/en/es + binder data-i18n
  js/main.js              UI: grid, transporte, Home, modal, localStorage
  image/                  favicon.svg, logo.gif, bg.png opcional
  audio/                  Reservado para samples futuros (vacía)
LICENSE                   Licencia MIT
```

## Cómo funciona el audio

- **Un solo `AudioContext`**, creado en el primer gesto del usuario (requisito del navegador).
- **Cadena de ganancia**: `4 ganancias de fila → master → masterFilter (BiquadFilter) → sidechainGain → compressor → destination`. El Filter Sweep modula `masterFilter`; el Sidechain modula `sidechainGain`.
- **Scheduler con lookahead** ("A Tale of Two Clocks"): un `setInterval` de 25 ms agenda las notas ~100 ms antes de `audioContext.currentTime`, manteniendo los loops sample-accurate y sincronizados al BPM.
- **Síntesis pura en runtime**: kick (seno con pitch drop), snare/hi-hat (ruido filtrado), bass/lead/arp (osciladores con secuencias de notas), voces (formantes + vibrato), pads (saws detunados), efectos (ruido + filtros). No hay archivos de audio.
- **Auto-pan**: los personajes con `pan: 'alt'` enrutan su salida por un `StereoPannerNode` que alterna L/R.

## Garantía offline

- Sin CDN, sin `fetch`/`XMLHttpRequest` a servidores remotos, sin fuentes ni imágenes externas.
- Favicon e íconos 100% locales/inline; los personajes usan SVG inline.
- Fondo opcional `src/image/bg.png` (si falta, los gradientes neon mantienen el look).
- Verificado en modo offline de DevTools y desde `file://`.

## Persistencia

El estado se guarda bajo la clave `musiclike-state-v2` en `localStorage`. Borra los datos del sitio en DevTools para resetear.

## Licencia

**Play Musik** es software de código abierto bajo la **Licencia MIT** (ver `LICENSE`).

- **Autor:** ELVIS ENRIQUE CHEN QIU — Panamá
- **Uso:** libre de usar, modificar, distribuir y compartir, con atribución.
- **Garantía:** el software se provee "tal cual", sin garantía de ningún tipo.