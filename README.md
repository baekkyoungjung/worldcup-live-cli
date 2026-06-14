# worldcup-live-cli

> **Watch football like you code.**

**English** · [한국어](README.ko.md) · [Español](README.es.md) · [Português](README.pt.md) · [日本語](README.ja.md)

A Claude Code plugin that turns a live World Cup match into **logger-style real-time text** (`log` / `warn` / `error` / `CRITICAL`) and streams it straight into your session — no second screen, no context switch. From a distance it reads like application logs. Up close, it's a commentator screaming.

```
14:32:21 [log]      Both sides trade passes in midfield
14:32:31 🟡 [warn]   Scotland win a corner on the right
14:33:05 🔴 [error]  Inside the Haiti box — the shot threatens the goal
14:35:48 🟥 [CRITICAL] GOAL! John McGinn — HAI 0 : 1 SCO
```

---

## Why it runs *inside* Claude Code

This is the whole point. The match doesn't live in a browser tab or a separate app — it streams into the same session you're already coding in.

- **No context switch.** You stay in your terminal/IDE. The feed appears as text in your session, the way a build log or a test runner would. Glance at it the way you glance at logs.
- **The skill consumes its own stream.** A background daemon polls the score; the skill `follow`s the log and prints only new lines into the session. You don't run `tail` and you don't babysit a process — you just say *"start the feed"* and watch.
- **Recap so you never lose the plot.** Step away to fix a bug? Every **10 minutes** (and at every half-time / water break) the skill posts a 2–4 line recap of what you missed. Come back, catch up in one glance, keep coding.
- **No static.** Even in quiet stretches it emits an ambient `[log]` line about every **10 seconds**, so the feed never looks frozen — but **scores, times, and player names are always real data**; ambient lines only describe the flow, they never invent facts.
- **Bonus camouflage.** Because it's logger output, to anyone walking by it looks exactly like a dev tool tailing logs. (This project started life as *사장 몰래* — "behind the boss's back." That heritage is now a feature, not the headline.)

## Install

In Claude Code, add this repo as a marketplace and install the plugin:

```
/plugin marketplace add baekkyoungjung/worldcup-live-cli
/plugin install worldcup-live-cli@worldcup-live-cli
```

What gets installed is a single bundle (`dist/poll.mjs`) plus assets — **no `npm install`, zero runtime dependencies.** All you need is **Node 18+**. If the `claude` CLI isn't available for narration, it falls back to built-in templates.

## Usage

After installing, just talk to your session in natural language — the skill handles everything from spinning up the daemon to streaming live in-session and posting recaps.

| Say this | What happens |
|---|---|
| "What matches are on today?" | Lists today's matches with their eventIds |
| "Start the feed" / "Watch the match" | Picks a live match and streams it into your session |
| "Replay the last game" / "Show me a fake one" | Replays a finished match as compressed fake-live |
| "What's the score?" | Summarizes the current score and recent action |
| "Stop the feed" | Stops the background daemon |

## Stream format — a severity logger

ESPN events are classified by danger level and tagged with a prefix. There are no field-position coordinates, so danger is approximated from the event type and ESPN text keywords ("box", "corner", "one-on-one", etc.).

| prefix | color / session | trigger |
|---|---|---|
| `[log]` | default | midfield duels, ordinary fouls, offsides, substitutions |
| `[warn]` | yellow / 🟡 | corners, free kicks, set pieces, dangerous-area passes/crosses |
| `[error]` | red / 🔴 | chances inside the box, shots, penalties |
| `[CRITICAL]` | red / 🟥 | goals |
| `[BREAK]` | cyan | half-time / water break (recap trigger) |

The Claude Code session can't render ANSI colors inside a code block, so **severity is shown with emoji**; in a terminal `tail -f` you get **ANSI colors** instead.

## How it works

```
┌─ daemon (background) ─────────────────────────────────┐
│  Polls ESPN's unofficial API (default 10s)            │
│    → classifies events: tier (poll speed) + severity  │
│    → narrates flow events via claude -p (headless)    │
│    → appends to ~/.worldcup-live-cli/match-{id}.log   │
│  On danger (shot/PK/goal): poll drops to 3s + instant │
│  In quiet stretches: ~10s ambient line, no static     │
└───────────────────────────────────────────────────────┘
        │
        ├─ Claude Code session (the skill, automatically):
        │    follow long-polls only new lines and prints them
        │    + posts recap every 10min / [BREAK] (byte-cursor
        │      dedupe blocks repeat output)
        │
        └─ terminal: tail -f ~/.worldcup-live-cli/match-{id}.log
```

The narrator is the daemon, not your session — so your session doesn't need to stay open and you can keep working. Danger moments print instantly from zero-latency templates; only flow events are narrated in `claude -p` batches (in practice one `claude -p` call takes ~11s, which can't keep up with the 3s cadence). All commentary text is in the reader's language; proper nouns (player/team names) are left as-is.

## Configuration

`~/.worldcup-live-cli/config.json` (see `config.example.json`):

- `ambientIntervalSec` — minimum gap between ambient lines (default 10s, floor 3s)
- `pollIntervalSec` / `tier2PollIntervalSec` — poll cadence (floors 10s / 3s, fixed in code)
- `tier2.lateGameMinute` / `closeScoreDiff` / `cooldownSec` — fast-poll promotion thresholds
- `narrator.mode` (`auto` / `claude` / `template`), `model`, `timeoutSec`

## Development

Source is TypeScript (`src/`, `scripts/`); the shipped artifact is a single esbuild-bundled `dist/poll.mjs` (zero runtime deps).

```bash
npm install            # tsx / esbuild / typescript (dev only)
npm run build          # scripts/poll.ts → dist/poll.mjs
npm run typecheck

node dist/poll.mjs list
node dist/poll.mjs daemon <eventId> &
node dist/poll.mjs replay <eventId> [--speed <n>] &
tail -f ~/.worldcup-live-cli/match-<eventId>.log
```

After changing the skill, run `npm run build` to refresh and commit `dist/poll.mjs` — installers only get the bundle.

## Data source & limits

This uses ESPN's unofficial (undocumented) API. No auth is required, but there's no official support and no SLA. The schema can change or get blocked at any time; when that happens the daemon doesn't die — it keeps raw JSON in a sidecar (`match-{id}.raw.jsonl`) and rides it out.

For the same reason the poll-interval floors (10s / 3s) are fixed in code and can't be lowered via config. If this tool gets popular and the endpoint gets blocked, everyone loses. Be gentle.

Minor matches may ship only `keyEvents` without minute-by-minute commentary. The feed gets sparser in that case, but big events and ambient flow are preserved.

## Disclaimer

This project is unaffiliated with ESPN and makes no guarantee about the availability of unofficial endpoints. Anything that happens from using it on company time is on you.

## License

MIT
