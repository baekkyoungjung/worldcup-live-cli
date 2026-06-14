# worldcup-live-cli

> **Mira el fútbol como programas.**

[English](README.md) · [한국어](README.ko.md) · **Español** · [Português](README.pt.md) · [日本語](README.ja.md)

Un plugin de Claude Code que convierte un partido del Mundial en vivo en **texto en tiempo real con formato de logger** (`log` / `warn` / `error` / `CRITICAL`) y lo transmite directamente a tu sesión: sin segunda pantalla, sin cambio de contexto. De lejos parecen logs de una aplicación; de cerca, es un comentarista gritando.

```
14:32:21 [log]      Ambos equipos se reparten el balón en el mediocampo
14:32:31 🟡 [warn]   Escocia consigue un córner por la derecha
14:33:05 🔴 [error]  Dentro del área de Haití: el remate amenaza la portería
14:35:48 🟥 [CRITICAL] ¡GOL! John McGinn — HAI 0 : 1 SCO
```

---

## Por qué corre *dentro* de Claude Code

Este es todo el punto. El partido no vive en una pestaña del navegador ni en una app aparte: se transmite a la misma sesión en la que ya estás programando.

- **Sin cambio de contexto.** No sales de tu terminal/IDE. El relato aparece como texto en tu sesión, igual que un log de build o un test runner. Lo miras de reojo como miras los logs.
- **La skill consume su propio stream.** Un daemon en segundo plano consulta el marcador; la skill hace `follow` del log e imprime solo las líneas nuevas en la sesión. No ejecutas `tail` ni vigilas un proceso: solo dices *"empieza la transmisión"* y miras.
- **Recap para no perder el hilo.** ¿Te apartaste a arreglar un bug? Cada **10 minutos** (y en cada descanso / pausa de hidratación) la skill publica un resumen de 2 a 4 líneas de lo que te perdiste. Vuelves, te pones al día de un vistazo y sigues programando.
- **Sin estática.** Incluso en los tramos tranquilos emite una línea ambiente `[log]` cada **10 segundos**, para que la transmisión nunca parezca congelada. Pero **el marcador, los tiempos y los nombres de los jugadores son siempre datos reales**; las líneas ambiente solo describen el ritmo del juego, nunca inventan hechos.
- **Camuflaje de regalo.** Como es salida de logger, para cualquiera que pase parece exactamente una herramienta de desarrollo siguiendo logs. (Este proyecto nació como *사장 몰래* — "a espaldas del jefe". Esa herencia ahora es una función, no el titular.)

## Instalación

En Claude Code, agrega este repositorio como marketplace e instala el plugin:

```
/plugin marketplace add baekkyoungjung/worldcup-live-cli
/plugin install worldcup-live-cli@worldcup-live-cli
```

Lo que se instala es un único bundle (`dist/poll.mjs`) más recursos: **sin `npm install`, cero dependencias en runtime.** Solo necesitas **Node 18+**. Si la CLI `claude` no está disponible para narrar, recurre a plantillas integradas.

## Uso

Tras instalar, basta con hablarle a tu sesión en lenguaje natural: la skill se encarga de todo, desde arrancar el daemon hasta transmitir en vivo dentro de la sesión y publicar los resúmenes.

| Si dices esto | Esto ocurre |
|---|---|
| "¿Qué partidos hay hoy?" | Lista los partidos de hoy con sus eventIds |
| "Empieza la transmisión" / "Mira el partido" | Elige un partido en vivo y lo transmite a tu sesión |
| "Repite el último partido" / "Muéstrame uno falso" | Reproduce un partido terminado como falso-en-vivo comprimido |
| "¿Cómo va el marcador?" | Resume el marcador actual y las jugadas recientes |
| "Detén la transmisión" | Detiene el daemon en segundo plano |

## Formato del stream — un logger por severidad

Los eventos de ESPN se clasifican por nivel de peligro y se etiquetan con un prefijo. No hay coordenadas de posición en el campo, así que el peligro se aproxima a partir del tipo de evento y de palabras clave del texto de ESPN ("box", "corner", "one-on-one", etc.).

| prefijo | color / sesión | criterio |
|---|---|---|
| `[log]` | por defecto | duelos en el mediocampo, faltas comunes, fueras de juego, cambios |
| `[warn]` | amarillo / 🟡 | córners, tiros libres, jugadas a balón parado, pases/centros en zona peligrosa |
| `[error]` | rojo / 🔴 | ocasiones dentro del área, remates, penaltis |
| `[CRITICAL]` | rojo / 🟥 | goles |
| `[BREAK]` | cian | descanso / pausa de hidratación (dispara el recap) |

La sesión de Claude Code no puede renderizar colores ANSI dentro de un bloque de código, así que **la severidad se muestra con emoji**; en un `tail -f` de terminal obtienes **colores ANSI**.

## Cómo funciona

```
┌─ daemon (segundo plano) ──────────────────────────────┐
│  Consulta la API no oficial de ESPN (por defecto 10s) │
│    → clasifica eventos: tier (velocidad) + severidad  │
│    → narra eventos de ritmo vía claude -p (headless)  │
│    → añade a ~/.worldcup-live-cli/match-{id}.log      │
│  En peligro (remate/penalti/gol): baja a 3s + al      │
│    instante. En tramos tranquilos: línea ambiente ~10s│
└───────────────────────────────────────────────────────┘
        │
        ├─ sesión de Claude Code (la skill, automáticamente):
        │    follow hace long-poll solo de líneas nuevas y las imprime
        │    + publica recap cada 10min / [BREAK] (un byte-cursor
        │      bloquea la salida repetida)
        │
        └─ terminal: tail -f ~/.worldcup-live-cli/match-{id}.log
```

Quien narra es el daemon, no tu sesión, así que tu sesión no necesita seguir abierta y puedes seguir trabajando. Los momentos de peligro se imprimen al instante desde plantillas de latencia cero; solo los eventos de ritmo se narran en lotes de `claude -p` (en la práctica una llamada a `claude -p` tarda ~11s, que no alcanza la cadencia de 3s). Todo el texto del relato sale en el idioma del lector; los nombres propios (jugadores/equipos) se dejan tal cual.

## Configuración

`~/.worldcup-live-cli/config.json` (ver `config.example.json`):

- `ambientIntervalSec` — intervalo mínimo entre líneas ambiente (por defecto 10s, mínimo 3s)
- `pollIntervalSec` / `tier2PollIntervalSec` — cadencia de sondeo (mínimos 10s / 3s, fijos en el código)
- `tier2.lateGameMinute` / `closeScoreDiff` / `cooldownSec` — umbrales para subir a sondeo rápido
- `narrator.mode` (`auto` / `claude` / `template`), `model`, `timeoutSec`

## Desarrollo

El código fuente es TypeScript (`src/`, `scripts/`); el artefacto publicado es un único `dist/poll.mjs` empaquetado con esbuild (cero dependencias en runtime).

```bash
npm install            # tsx / esbuild / typescript (solo dev)
npm run build          # scripts/poll.ts → dist/poll.mjs
npm run typecheck

node dist/poll.mjs list
node dist/poll.mjs daemon <eventId> &
node dist/poll.mjs replay <eventId> [--speed <n>] &
tail -f ~/.worldcup-live-cli/match-<eventId>.log
```

Tras cambiar la skill, ejecuta `npm run build` para refrescar y commitear `dist/poll.mjs`: quien instala solo recibe el bundle.

## Fuente de datos y límites

Usa la API no oficial (sin documentar) de ESPN. No requiere autenticación, pero no hay soporte oficial ni SLA. El esquema puede cambiar o bloquearse en cualquier momento; cuando eso pasa el daemon no muere: guarda el JSON crudo en un sidecar (`match-{id}.raw.jsonl`) y aguanta.

Por la misma razón los mínimos del intervalo de sondeo (10s / 3s) están fijos en el código y no se pueden bajar por configuración. Si esta herramienta se vuelve popular y el endpoint se bloquea, todos perdemos. Úsala con mesura.

Los partidos menores pueden traer solo `keyEvents` sin comentario minuto a minuto. En ese caso la transmisión se vuelve más escasa, pero se preservan los grandes eventos y el ritmo ambiente.

## Aviso

Este proyecto no está afiliado a ESPN y no garantiza la disponibilidad de los endpoints no oficiales. Lo que pase por usarlo en horario laboral es cosa tuya.

## Licencia

MIT
