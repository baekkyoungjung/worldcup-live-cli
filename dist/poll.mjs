#!/usr/bin/env tsx

// src/config.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// src/types.ts
var HARD_MIN_POLL_SEC = 10;
var HARD_MIN_TIER2_POLL_SEC = 3;

// src/config.ts
var CONFIG_DIR = path.join(os.homedir(), ".e2e-monitor");
var DEFAULTS = {
  league: "fifa.world",
  logDir: CONFIG_DIR,
  goalAnimation: true,
  pollIntervalSec: 10,
  tier2PollIntervalSec: 3,
  tier2: {
    typeIds: [],
    lateGameMinute: 80,
    closeScoreDiff: 1,
    cooldownSec: 120
  },
  narrator: {
    mode: "auto",
    model: "haiku",
    timeoutSec: 25
  }
};
function loadConfig(configPath) {
  const file = configPath ?? path.join(CONFIG_DIR, "config.json");
  let user = {};
  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      process.stderr.write(`[e2e-monitor] config \uD30C\uC2F1 \uC2E4\uD328(${e}) \u2014 \uAE30\uBCF8\uAC12 \uC0AC\uC6A9
`);
    }
  }
  const merged = {
    ...DEFAULTS,
    ...user,
    tier2: { ...DEFAULTS.tier2, ...user.tier2 ?? {} },
    narrator: { ...DEFAULTS.narrator, ...user.narrator ?? {} }
  };
  merged.pollIntervalSec = Math.max(HARD_MIN_POLL_SEC, Number(merged.pollIntervalSec) || HARD_MIN_POLL_SEC);
  merged.tier2PollIntervalSec = Math.max(
    HARD_MIN_TIER2_POLL_SEC,
    Number(merged.tier2PollIntervalSec) || HARD_MIN_TIER2_POLL_SEC
  );
  merged.tier2.typeIds = Array.isArray(merged.tier2.typeIds) ? merged.tier2.typeIds.map(String) : [];
  merged.tier2.lateGameMinute = finiteOr(merged.tier2.lateGameMinute, DEFAULTS.tier2.lateGameMinute);
  merged.tier2.closeScoreDiff = finiteOr(merged.tier2.closeScoreDiff, DEFAULTS.tier2.closeScoreDiff);
  merged.tier2.cooldownSec = finiteOr(merged.tier2.cooldownSec, DEFAULTS.tier2.cooldownSec);
  merged.narrator.timeoutSec = Math.max(5, finiteOr(merged.narrator.timeoutSec, DEFAULTS.narrator.timeoutSec));
  if (!["auto", "claude", "template"].includes(merged.narrator.mode)) merged.narrator.mode = "auto";
  merged.narrator.model = typeof merged.narrator.model === "string" ? merged.narrator.model : DEFAULTS.narrator.model;
  merged.goalAnimation = merged.goalAnimation !== false;
  merged.league = typeof merged.league === "string" && merged.league ? merged.league : DEFAULTS.league;
  merged.logDir = expandHome(typeof merged.logDir === "string" && merged.logDir ? merged.logDir : DEFAULTS.logDir);
  merged.skin = typeof merged.skin === "string" ? merged.skin : void 0;
  return merged;
}
function finiteOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function expandHome(p) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

// src/celebrate.ts
import fs3 from "node:fs";
import path3 from "node:path";
import { fileURLToPath } from "node:url";

// src/logger.ts
import fs2 from "node:fs";
import path2 from "node:path";
var WRAP_COL = 100;
function matchLogPath(logDir, matchId) {
  return path2.join(logDir, `match-${matchId}.log`);
}
function matchDonePath(logDir, matchId) {
  return path2.join(logDir, `match-${matchId}.done`);
}
function writerPidPath(logDir, matchId) {
  return path2.join(logDir, `match-${matchId}.writer.pid`);
}
var MatchLogger = class {
  logPath;
  rawPath;
  donePath;
  pidPath;
  wrapIndent;
  constructor(logDir, matchId, wrapIndent) {
    fs2.mkdirSync(logDir, { recursive: true });
    this.logPath = matchLogPath(logDir, matchId);
    this.rawPath = path2.join(logDir, `match-${matchId}.raw.jsonl`);
    this.donePath = matchDonePath(logDir, matchId);
    this.pidPath = writerPidPath(logDir, matchId);
    this.wrapIndent = Number.isFinite(wrapIndent) ? Math.min(Math.max(0, Math.trunc(wrapIndent)), WRAP_COL - 40) : 8;
  }
  /** 위장 로그 한 줄. 길면 wrapIndent 들여쓰기로 줄바꿈 — README 예시의 2행 포맷 */
  line(text) {
    try {
      fs2.appendFileSync(this.logPath, this.wrap(text) + "\n");
    } catch {
    }
  }
  /**
   * tier-2 스트리밍: 여러 줄을 호흡 끊어 한 줄씩 flush.
   * 줄 사이 지연은 캐스터의 호흡 — 다음 폴링 주기를 침범하지 않는 범위로 clamp.
   */
  async stream(lines, gapMs) {
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await sleep(gapMs);
      this.line(lines[i]);
    }
  }
  /**
   * 미리 조판된 텍스트(골 애니메이션 프레임)의 raw append — wrap 없이 그대로.
   * ANSI 색 코드가 길이 계산에 섞이면 wrap이 아트를 찢는다.
   */
  art(text) {
    try {
      fs2.appendFileSync(this.logPath, text + "\n");
    } catch {
    }
  }
  /**
   * 위장 로그를 오염시키지 않는 사이드카. 스키마 변경·장애 시 raw JSON은 여기 쌓인다.
   * (위장 원칙: 메인 로그에 이벤트가 아닌 것을 흘리지 않는다)
   */
  raw(kind, payload) {
    const entry = { ts: (/* @__PURE__ */ new Date()).toISOString(), kind, payload };
    try {
      fs2.appendFileSync(this.rawPath, JSON.stringify(entry) + "\n");
    } catch {
    }
  }
  /**
   * 중계 종료 마커. 반드시 최종 보고의 마지막 라인 append가 끝난 뒤에 불러야 한다 —
   * follow는 "done 존재 + EOF 도달"을 동시에 봐야 종료로 판정하지만, done이 보고
   * 중간에 먼저 생기면 잔여 라인을 버리고 턴을 끝내는 race가 된다.
   */
  markDone() {
    try {
      fs2.writeFileSync(this.donePath, (/* @__PURE__ */ new Date()).toISOString());
    } catch {
    }
  }
  /** 이전 경기(또는 이전 재생)의 stale done 제거 — writer 기동 직후 호출 */
  clearDone() {
    try {
      fs2.unlinkSync(this.donePath);
    } catch {
    }
  }
  markWriter() {
    try {
      fs2.writeFileSync(this.pidPath, String(process.pid));
    } catch {
    }
  }
  clearWriter() {
    try {
      fs2.unlinkSync(this.pidPath);
    } catch {
    }
  }
  wrap(text) {
    if (text.length <= WRAP_COL) return text;
    if (WRAP_COL - this.wrapIndent <= 0) return text;
    const indent = " ".repeat(this.wrapIndent);
    const out = [];
    let rest = text;
    let first = true;
    while (rest.length > 0) {
      const width = first ? WRAP_COL : WRAP_COL - this.wrapIndent;
      if (rest.length <= width) {
        out.push(first ? rest : indent + rest);
        break;
      }
      let cut = rest.lastIndexOf(" ", width);
      if (cut < width * 0.6) cut = width;
      out.push((first ? "" : indent) + rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
      first = false;
    }
    return out.join("\n");
  }
};
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// src/celebrate.ts
var ART_DIR = path3.resolve(path3.dirname(fileURLToPath(import.meta.url)), "../art/goal");
var MAX_FRAMES = 40;
var MIN_DELAY_MS = 50;
var MAX_DELAY_MS = 2e3;
var MAX_TOTAL_MS = 15e3;
var MAX_LINE_WIDTH = 110;
var DEFAULT_DELAY_MS = 600;
var COLOR_TOKENS = {
  reset: "\x1B[0m",
  bold: "\x1B[1m",
  dim: "\x1B[2m",
  red: "\x1B[31m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  cyan: "\x1B[36m",
  white: "\x1B[37m"
};
var cachedArts = null;
var inFlight = false;
async function celebrateGoal(logger) {
  if (inFlight) return;
  inFlight = true;
  try {
    const arts = loadArts();
    if (arts.length === 0) return;
    const frames = arts[Math.floor(Math.random() * arts.length)];
    for (const f of frames) {
      logger.art(f.text);
      await sleep(f.delayMs);
    }
  } catch {
  } finally {
    inFlight = false;
  }
}
function loadArts() {
  if (cachedArts) return cachedArts;
  const arts = [];
  try {
    for (const file of fs3.readdirSync(ART_DIR).filter((f) => f.endsWith(".txt")).sort()) {
      try {
        const frames = parseArt(fs3.readFileSync(path3.join(ART_DIR, file), "utf8"));
        if (frames.length > 0) arts.push(frames);
      } catch {
      }
    }
  } catch {
  }
  if (arts.length === 0) arts.push(parseArt(BUILTIN_ART));
  cachedArts = arts;
  return arts;
}
function parseArt(src) {
  const frames = [];
  for (const block of src.split(/^---\s*$/m)) {
    if (frames.length >= MAX_FRAMES) break;
    let delayMs = DEFAULT_DELAY_MS;
    const artLines = [];
    for (const line of block.replace(/^\n+|\n+$/g, "").split("\n")) {
      const d = /^#delay\s+(\d+)\s*$/.exec(line);
      if (d) delayMs = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, Number(d[1])));
      if (/^#delay\b/.test(line)) continue;
      if (/^#(\s|$)/.test(line)) continue;
      artLines.push(renderLine(line));
    }
    const text = artLines.join("\n");
    if (text.trim().length === 0) continue;
    frames.push({ text, delayMs });
  }
  const total = frames.reduce((s, f) => s + f.delayMs, 0);
  if (total > MAX_TOTAL_MS) {
    const scale = MAX_TOTAL_MS / total;
    for (const f of frames) f.delayMs = Math.round(f.delayMs * scale);
  }
  return frames;
}
function renderLine(line) {
  let colored = false;
  let out = "";
  let budget = MAX_LINE_WIDTH;
  let last = 0;
  const emit = (text) => {
    const take = text.slice(0, Math.max(0, budget));
    out += take;
    budget -= take.length;
  };
  for (const m of line.matchAll(/\{(\w+)\}/g)) {
    emit(line.slice(last, m.index));
    const code = COLOR_TOKENS[m[1]];
    if (code === void 0) {
      emit(m[0]);
    } else {
      out += code;
      colored = true;
    }
    last = m.index + m[0].length;
  }
  emit(line.slice(last));
  return colored && !out.endsWith(COLOR_TOKENS.reset) ? out + COLOR_TOKENS.reset : out;
}
var BUILTIN_ART = `#delay 450
{dim}        \u25CF{reset}
---
#delay 380
{dim}                \u25CF{reset}
---
#delay 300
{dim}                          \u25CF{reset}
---
#delay 240
{cyan}                                    \u25CF{reset}
---
#delay 200
{cyan}                                            \u25CF\u25B8{reset}
---
#delay 600
{bold}{yellow}                                               \u2297 \uACE8\uB9DD\uC774 \uCC22\uC5B4\uC9C4\uB2E4{reset}
---
#delay 400
{bold}{yellow}      \u2588\u2588\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2588\u2588\u2588\u2557  \u2588\u2588\u2557      \u2588\u2588\u2557{reset}
---
#delay 400
{bold}{yellow}     \u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D \u2588\u2588\u2554\u2550\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557 \u2588\u2588\u2551      \u2588\u2588\u2551{reset}
---
#delay 400
{bold}{yellow}     \u2588\u2588\u2551  \u2588\u2588\u2588\u2557\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551 \u2588\u2588\u2551      \u2588\u2588\u2551{reset}
---
#delay 400
{bold}{yellow}     \u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551 \u2588\u2588\u2551      \u255A\u2550\u255D{reset}
---
#delay 400
{bold}{yellow}     \u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2551  \u2588\u2588\u2551 \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2557{reset}
---
#delay 400
{bold}{yellow}      \u255A\u2550\u2550\u2550\u2550\u2550\u255D  \u255A\u2550\u2550\u2550\u2550\u2550\u255D \u255A\u2550\u255D  \u255A\u2550\u255D \u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D \u255A\u2550\u255D{reset}
---
#delay 900
{yellow}        \u2726 \u2726 \u2726 \u2726 \u2726 \u2726 \u2726 \u2726 \u2726 \u2726 \u2726 \u2726 \u2726 \u2726 \u2726 \u2726 \u2726{reset}
---
#delay 700
{bold}{yellow}     G  O  O  O  O  O  O  O  O  O  A  L  !{reset}
---
#delay 700
{yellow}           G O O O O O A L !{reset}
---
#delay 750
{dim}                 g o o a l \u2026{reset}
---
#delay 900
{dim}                     \uAD00\uC911\uC11D\uC774 \uBB34\uB108\uC9C4\uB2E4. \uC228\uC744 \uACE0\uB974\uACE0, \uC911\uACC4\uB85C \uBCF5\uADC0.{reset}
---
#delay 250
{dim}\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500{reset}
`;

// src/espn.ts
var BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
var UA = "e2e-monitor/1.0 (+https://github.com)";
async function getJson(url) {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15e3) });
    const body = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, rawBody: body.slice(0, 4e3) };
    try {
      return { ok: true, data: JSON.parse(body) };
    } catch {
      return { ok: false, error: "invalid JSON", rawBody: body.slice(0, 4e3) };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
async function fetchScoreboard(league) {
  const res = await getJson(`${BASE}/${league}/scoreboard`);
  if (!res.ok) return res;
  try {
    const d = res.data;
    const entries = (d.events ?? []).map((e) => {
      const comp = e.competitions?.[0] ?? {};
      const find = (side) => (comp.competitors ?? []).find((c) => c.homeAway === side) ?? {};
      const home = find("home");
      const away = find("away");
      return {
        id: String(e.id ?? ""),
        name: String(e.shortName ?? e.name ?? ""),
        state: e.status?.type?.state ?? "unknown",
        detail: String(e.status?.type?.detail ?? ""),
        home: String(home.team?.abbreviation ?? "?"),
        away: String(away.team?.abbreviation ?? "?"),
        homeScore: String(home.score ?? "-"),
        awayScore: String(away.score ?? "-"),
        dateUtc: String(e.date ?? "")
      };
    });
    return { ok: true, data: entries };
  } catch (e) {
    return { ok: false, error: `schema: ${e}`, rawBody: JSON.stringify(res.data).slice(0, 4e3) };
  }
}
async function fetchSummary(league, eventId) {
  const res = await getJson(`${BASE}/${league}/summary?event=${encodeURIComponent(eventId)}`);
  if (!res.ok) return res;
  try {
    return { ok: true, data: parseSummary(res.data, eventId) };
  } catch (e) {
    return {
      ok: false,
      error: `schema: ${e instanceof Error ? e.message : e}`,
      rawBody: JSON.stringify(res.data).slice(0, 8e3)
    };
  }
}
function parseSummary(data, eventId) {
  const d = data;
  const comp = d?.header?.competitions?.[0];
  if (!comp) throw new Error("header.competitions[0] \uC5C6\uC74C");
  const status = comp.status ?? {};
  const find = (side) => (comp.competitors ?? []).find((c) => c.homeAway === side) ?? {};
  const home = find("home");
  const away = find("away");
  const abbrOf = (c) => String(c.team?.abbreviation ?? c.team?.displayName ?? "?");
  const nameOf = (c) => String(c.team?.displayName ?? c.team?.abbreviation ?? "?");
  const teamAbbrByName = /* @__PURE__ */ new Map([
    [nameOf(home), abbrOf(home)],
    [nameOf(away), abbrOf(away)]
  ]);
  const commentary = Array.isArray(d.commentary) ? d.commentary : [];
  const keyEvents = Array.isArray(d.keyEvents) ? d.keyEvents : [];
  const keyEventsOnly = commentary.length === 0 && keyEvents.length > 0;
  const items = keyEventsOnly ? keyEvents.map((k) => normalizeKeyEvent(k, teamAbbrByName)).filter((x) => x !== null) : commentary.map((c) => normalizeCommentary(c, teamAbbrByName)).filter((x) => x !== null);
  return {
    matchId: eventId,
    state: status.type?.state ?? "unknown",
    statusDetail: String(status.type?.detail ?? ""),
    homeTeam: nameOf(home),
    awayTeam: nameOf(away),
    homeAbbr: abbrOf(home),
    awayAbbr: abbrOf(away),
    homeScore: toInt(home.score),
    awayScore: toInt(away.score),
    venue: String(d?.gameInfo?.venue?.fullName ?? ""),
    minuteNum: parseClockMinute(String(status.displayClock ?? "")),
    items,
    keyEventsOnly
  };
}
function normalizeCommentary(c, teamAbbrByName) {
  if (c == null || typeof c !== "object") return null;
  const seq = c.sequence;
  if (seq === void 0 || seq === null) return null;
  const play = c.play ?? {};
  const clock = play.clock ?? {};
  const minute = String(clock.displayValue ?? c.time?.displayValue ?? "");
  const text = String(c.text ?? play.text ?? "").trim();
  if (!text) return null;
  return {
    id: `seq:${seq}`,
    typeId: String(play.type?.id ?? ""),
    typeText: String(play.type?.text ?? ""),
    text,
    minuteNum: parseClockMinute(minute) || Math.ceil(Number(clock.value ?? 0) / 60),
    minute,
    player: play.participants?.[0]?.athlete?.displayName ?? void 0,
    teamAbbr: teamAbbrByName.get(String(play.team?.displayName ?? "")) ?? void 0
  };
}
function normalizeKeyEvent(k, teamAbbrByName) {
  if (k == null || typeof k !== "object" || k.id == null) return null;
  const clock = k.clock ?? {};
  const minute = String(clock.displayValue ?? "");
  return {
    id: `ke:${k.id}`,
    typeId: String(k.type?.id ?? ""),
    typeText: String(k.type?.text ?? ""),
    text: String(k.text ?? k.shortText ?? k.type?.text ?? "").trim(),
    minuteNum: parseClockMinute(minute) || Math.ceil(Number(clock.value ?? 0) / 60),
    minute,
    player: k.participants?.[0]?.athlete?.displayName ?? void 0,
    teamAbbr: teamAbbrByName.get(String(k.team?.displayName ?? "")) ?? void 0,
    scoringPlay: k.scoringPlay === true
  };
}
function parseClockMinute(display) {
  const m = /^(\d+)'/.exec(display);
  return m ? Number(m[1]) : 0;
}
function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// src/narrate.ts
import { execFile } from "node:child_process";
var Narrator = class {
  available = null;
  config;
  constructor(config) {
    this.config = config;
  }
  async isAvailable() {
    if (this.config.narrator.mode === "template") return false;
    if (this.available !== null) return this.available;
    this.available = await new Promise((resolve) => {
      const watchdog = setTimeout(() => resolve(false), 12e3);
      execFile("claude", ["--version"], { timeout: 1e4, killSignal: "SIGKILL" }, (err) => {
        clearTimeout(watchdog);
        resolve(!err);
      });
    });
    return this.available;
  }
  /**
   * 이벤트 묶음을 1회 호출로 각색. 실패·timeout·개수 불일치 시 null — 호출부가 템플릿 폴백.
   * 반환: 이벤트 순서와 같은 desc 문자열 배열.
   */
  async narrateBatch(events, skin) {
    if (events.length === 0) return [];
    if (!await this.isAvailable()) return null;
    const list = events.map((e, i) => `${i + 1}. [${e.minute}] (${e.category}) ${e.rawText}`).join("\n");
    const prompt = [
      skin.guide,
      "",
      "\uC544\uB798 \uCD95\uAD6C \uC774\uBCA4\uD2B8 \uAC01\uAC01\uC5D0 \uB300\uD574 \uC704 \uAC00\uC774\uB4DC\uB97C \uB530\uB974\uB294 \uBB18\uC0AC \uD14D\uC2A4\uD2B8\uB97C \uC0DD\uC131\uD558\uB77C.",
      "- \uBB18\uC0AC\uB294 \uBC18\uB4DC\uC2DC \uD55C\uAD6D\uC5B4\uB85C \uC4F4\uB2E4. \uC120\uC218\uBA85\xB7\uD300\uBA85 \uB4F1 \uACE0\uC720\uBA85\uC0AC\uB9CC \uC6D0\uBB38 \uD45C\uAE30\uB97C \uD5C8\uC6A9\uD55C\uB2E4.",
      "- \uBB18\uC0AC \uBCF8\uBB38\uB9CC. \uD0C0\uC784\uC2A4\uD0EC\uD504\xB7\uC0C1\uD0DC \uD0DC\uADF8\xB7\uC811\uB450\uC0AC\uB294 \uC2DC\uC2A4\uD15C\uC774 \uBD99\uC778\uB2E4.",
      "- \uC2A4\uCF54\uC5B4\xB7\uC2DC\uAC04\xB7\uC120\uC218\uBA85\uC740 \uC785\uB825\uC5D0 \uC788\uB294 \uAC83\uB9CC \uC0AC\uC6A9\uD558\uACE0 \uC808\uB300 \uBC14\uAFB8\uC9C0 \uC54A\uB294\uB2E4.",
      "- \uC785\uB825\uC5D0 \uC5C6\uB294 \uC0AC\uC2E4(\uC5B4\uC2DC\uC2A4\uD2B8, \uBD80\uC0C1, \uAD00\uC911 \uC218 \uB4F1)\uC744 \uC9C0\uC5B4\uB0B4\uC9C0 \uC54A\uB294\uB2E4.",
      `- \uCD9C\uB825\uC740 JSON \uBB38\uC790\uC5F4 \uBC30\uC5F4 \uD558\uB098\uB9CC. \uAE38\uC774 ${events.length}, \uC774\uBCA4\uD2B8 \uC21C\uC11C \uADF8\uB300\uB85C.`,
      "",
      "\uC774\uBCA4\uD2B8:",
      list
    ].join("\n");
    const out = await this.run(prompt, this.config.narrator.timeoutSec * 1e3);
    if (out === null) return null;
    const parsed = extractJsonArray(out);
    if (!parsed || parsed.length !== events.length) return null;
    return parsed.map((s) => sanitizeDesc(s));
  }
  /** tier-2 사후 보강용 단건 각색 */
  async narrateOne(event, skin) {
    const batch = await this.narrateBatch([event], skin);
    return batch?.[0] ?? null;
  }
  run(prompt, timeoutMs) {
    return new Promise((resolve) => {
      const watchdog = setTimeout(() => resolve(null), timeoutMs + 5e3);
      execFile(
        "claude",
        ["-p", prompt, "--model", this.config.narrator.model],
        { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          clearTimeout(watchdog);
          resolve(err ? null : stdout);
        }
      );
    });
  }
};
function extractJsonArray(out) {
  const m = /\[[\s\S]*\]/.exec(out);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    if (Array.isArray(arr) && arr.every((x) => typeof x === "string")) return arr;
  } catch {
  }
  return null;
}
function sanitizeDesc(s) {
  let d = s.replace(/```[\s\S]*?```/g, " ").replace(/[`*_>#]/g, "");
  d = d.split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
  d = d.replace(/\s+/g, " ").trim();
  if (d.length > 140) d = d.slice(0, 139) + "\u2026";
  return d;
}

// src/skin.ts
import fs4 from "node:fs";
import path4 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var SKINS_DIR = path4.resolve(path4.dirname(fileURLToPath2(import.meta.url)), "../skins");
function parseSkin(md, fallbackName) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(md);
  const meta = {};
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = /^(\w+):\s*(.*)$/.exec(line.trim());
      if (m) meta[m[1]] = m[2];
    }
  }
  let detect = [];
  try {
    detect = JSON.parse(meta.detect ?? "[]");
  } catch {
    detect = [];
  }
  const guideMatch = /#{1,6}\s*각색 가이드\s*\n([\s\S]*?)(?=\n#{1,6}\s|$)/.exec(md);
  const guide = (guideMatch?.[1] ?? "").trim();
  const templates = {};
  for (const ini of md.matchAll(/```ini\n([\s\S]*?)```/g)) {
    for (const line of ini[1].split("\n")) {
      const m = /^([\w.]+)\s*=\s*(.*)$/.exec(line);
      if (m) templates[m[1]] = m[2];
    }
  }
  const name = meta.name ?? fallbackName;
  if (Object.keys(templates).length === 0) {
    process.stderr.write(`[e2e-monitor] \uC2A4\uD0A8 "${name}": \uB77C\uC778 \uD15C\uD50C\uB9BF(\`\`\`ini \uBE14\uB85D)\uC774 \uBE44\uC5B4 \uC788\uC74C \u2014 \uCD9C\uB825\uC774 \uC5C6\uC744 \uAC83
`);
  } else {
    for (const key of ["kickoff.fact", "goal.fact", "generic.flavor"]) {
      if (!templates[key]) process.stderr.write(`[e2e-monitor] \uC2A4\uD0A8 "${name}": \uAD8C\uC7A5 \uD0A4 ${key} \uB204\uB77D
`);
    }
  }
  if (!guide) {
    process.stderr.write(`[e2e-monitor] \uC2A4\uD0A8 "${name}": "# \uAC01\uC0C9 \uAC00\uC774\uB4DC" \uC139\uC158\uC774 \uBE44\uC5B4 \uC788\uC74C \u2014 \uAC01\uC0C9 \uD1A4\uC774 \uBE60\uC9C4\uB2E4
`);
  }
  const rawIndent = Number(meta.wrapIndent);
  return {
    name,
    description: meta.description ?? "",
    detect,
    wrapIndent: Number.isFinite(rawIndent) ? Math.min(Math.max(0, Math.trunc(rawIndent)), 60) : 8,
    guide,
    templates
  };
}
function listSkins() {
  if (!fs4.existsSync(SKINS_DIR)) return [];
  return fs4.readdirSync(SKINS_DIR).filter((f) => f.endsWith(".md") && f !== "README.md").map((f) => f.replace(/\.md$/, "")).sort();
}
function loadSkinByName(name) {
  const file = path4.join(SKINS_DIR, `${name}.md`);
  if (!fs4.existsSync(file)) return null;
  return parseSkin(fs4.readFileSync(file, "utf8"), name);
}
function resolveSkin(config, cwd) {
  if (config.skin) {
    const s = loadSkinByName(config.skin);
    if (s) return s;
    process.stderr.write(`[e2e-monitor] \uC2A4\uD0A8 "${config.skin}" \uC5C6\uC74C \u2014 cwd \uCD94\uC815\uC73C\uB85C \uD3F4\uBC31
`);
  }
  for (const name of listSkins()) {
    const s = loadSkinByName(name);
    if (!s || s.detect.length === 0) continue;
    const hit = s.detect.some((pattern) => {
      if (pattern.includes("*")) {
        const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
        try {
          return fs4.readdirSync(cwd).some((f) => re.test(f));
        } catch {
          return false;
        }
      }
      return fs4.existsSync(path4.join(cwd, pattern));
    });
    if (hit) return s;
  }
  return loadSkinByName("ts-dev") ?? parseSkin("", "empty");
}
function fillTemplate(tpl2, vars) {
  return tpl2.replace(/\{(\w+)\}/g, (_, key) => {
    const v = vars[key];
    return v === void 0 || v === null ? "" : String(v);
  });
}

// src/render.ts
function nowStamp() {
  const d = /* @__PURE__ */ new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function buildVars(event, snap, desc) {
  const scoring = event?.teamAbbr;
  const conceding = scoring === snap.homeAbbr ? snap.awayAbbr : scoring === snap.awayAbbr ? snap.homeAbbr : "";
  const scoringTeam = scoring === snap.homeAbbr ? snap.homeTeam : scoring === snap.awayAbbr ? snap.awayTeam : "";
  const fromText = event?.category === "goal" ? parseScoreFromGoalText(event.rawText, snap) : null;
  return {
    time: nowStamp(),
    matchId: snap.matchId,
    venue: snap.venue || "unknown-venue",
    homeTeam: snap.homeTeam,
    awayTeam: snap.awayTeam,
    homeAbbr: snap.homeAbbr,
    awayAbbr: snap.awayAbbr,
    homeScore: fromText?.home ?? snap.homeScore,
    awayScore: fromText?.away ?? snap.awayScore,
    minute: event?.minute ?? `${snap.minuteNum}'`,
    minuteNum: event?.minuteNum ?? snap.minuteNum,
    player: event?.player ?? "",
    teamAbbr: event?.teamAbbr ?? "",
    scoringAbbr: scoring ?? "",
    concedingAbbr: conceding,
    scoringTeam,
    rawText: event?.rawText ?? "",
    desc: desc ?? ""
  };
}
function parseScoreFromGoalText(text, snap) {
  const m = /(?:Goal!|Own Goal[^.]*\.)\s+(.+?)\s+(\d+)[,:]\s+(.+?)\s+(\d+)\./.exec(text);
  if (!m) return null;
  const [, nameA, scoreA, nameB, scoreB] = m;
  const pairs = [
    [nameA.trim(), Number(scoreA)],
    [nameB.trim(), Number(scoreB)]
  ];
  let home = null;
  let away = null;
  for (const [name, score] of pairs) {
    if (matchesTeam(name, snap.homeTeam, snap.homeAbbr)) home = score;
    else if (matchesTeam(name, snap.awayTeam, snap.awayAbbr)) away = score;
  }
  return home !== null && away !== null ? { home, away } : null;
}
function matchesTeam(name, displayName, abbr) {
  const n = name.toLowerCase();
  const d = displayName.toLowerCase();
  if (n === d || n === abbr.toLowerCase()) return true;
  const tokens = (s) => new Set(s.split(/\s+/).filter((t) => t.length > 3));
  const a = tokens(n);
  const b = tokens(d);
  for (const t of a) if (b.has(t)) return true;
  return false;
}
function tpl(skin, key, fallbackKey) {
  return skin.templates[key] ?? (fallbackKey ? skin.templates[fallbackKey] : void 0) ?? null;
}
var KO_DESC_BY_TYPE = {
  "66": "\uD30C\uC6B8 \uD718\uC2AC\uC774 \uC6B8\uB9B0\uB2E4, \uD750\uB984\uC774 \uC7A0\uC2DC \uB04A\uAE34\uB2E4",
  "68": "\uBD80\uC2EC \uAE43\uBC1C\uC774 \uC62C\uB77C\uAC04\uB2E4 \u2014 \uC624\uD504\uC0AC\uC774\uB4DC",
  "122": "\uD578\uB4DC\uBCFC \uC120\uC5B8",
  "129": "\uACBD\uAE30\uAC00 \uC7A0\uC2DC \uBA48\uCD98\uB2E4",
  "130": "\uACBD\uAE30\uAC00 \uC7A0\uC2DC \uBA48\uCD98\uB2E4"
};
function renderEvent(event, snap, skin, desc) {
  const cat = event.category;
  const vars0 = buildVars(event, snap);
  let finalDesc = desc && desc.trim() ? sanitizeDesc(desc) : "";
  if (!finalDesc) {
    const fallbackTpl = tpl(skin, `${cat}.desc`, "generic.desc");
    if (fallbackTpl) finalDesc = sanitizeDesc(fillTemplate(fallbackTpl, vars0).trim());
  }
  if (!finalDesc) finalDesc = KO_DESC_BY_TYPE[event.typeId ?? ""] ?? "";
  const vars = buildVars(event, snap, finalDesc);
  const lines = [];
  const factOnly = cat === "kickoff" || cat === "halftime" || cat === "fulltime" || cat === "resume";
  if (!factOnly) {
    const flavorKey = cat === "goal" && !event.teamAbbr ? "generic.flavor" : `${cat}.flavor`;
    const flavor = tpl(skin, flavorKey, "generic.flavor");
    if (flavor && finalDesc) lines.push(fillTemplate(flavor, vars));
  }
  const fact = tpl(skin, `${cat}.fact`);
  if (fact) lines.push(fillTemplate(fact, vars));
  if (factOnly && lines.length === 0) {
    const generic = tpl(skin, "generic.flavor");
    if (generic) lines.push(fillTemplate(generic, vars));
  }
  return lines;
}
function renderReplay(event, snap, skin, desc) {
  const replay = tpl(skin, "replay.flavor");
  if (!replay) return null;
  return fillTemplate(replay, buildVars(event, snap, desc));
}
function renderFinalReport(snap, highlights, skin) {
  const lines = [];
  const vars = buildVars(null, snap);
  const header = tpl(skin, "report.header");
  const lineTpl = tpl(skin, "report.line");
  const footer = tpl(skin, "report.footer");
  if (header) lines.push(fillTemplate(header, vars));
  if (lineTpl) {
    lines.push(fillTemplate(lineTpl, { ...vars, item: `FT ${snap.homeAbbr} ${snap.homeScore} : ${snap.awayScore} ${snap.awayAbbr}` }));
    for (const h of highlights) {
      const who = [h.minute, h.player || h.teamAbbr || "", labelOf(h)].filter(Boolean).join(" ");
      lines.push(fillTemplate(lineTpl, { ...vars, item: who }));
    }
  }
  if (footer) lines.push(fillTemplate(footer, vars));
  return lines;
}
function labelOf(e) {
  switch (e.category) {
    case "goal":
      return "\uB4DD\uC810";
    case "red":
      return "\uD1F4\uC7A5";
    case "penalty":
      return "PK";
    case "yellow":
      return "\uACBD\uACE0";
    case "var":
      return "VAR";
    case "sub":
      return "\uAD50\uCCB4";
    case "chance":
      return "\uAE30\uD68C";
    case "setpiece":
      return "\uC138\uD2B8\uD53C\uC2A4";
    default:
      return "\uAE30\uB85D";
  }
}

// src/state.ts
import fs5 from "node:fs";
import path5 from "node:path";
var MatchStateStore = class {
  seen = /* @__PURE__ */ new Set();
  statePath;
  lastState = "unknown";
  lastHomeScore = 0;
  lastAwayScore = 0;
  announcedHome = 0;
  announcedAway = 0;
  kickoffAnnounced = false;
  halftimeAnnounced = false;
  fulltimeAnnounced = false;
  lastSource = null;
  /** 최종 보고용 골/퇴장 — 재시작에도 살아남도록 영속화 */
  highlights = [];
  constructor(logDir, matchId) {
    fs5.mkdirSync(logDir, { recursive: true });
    this.statePath = path5.join(logDir, `state-${matchId}.json`);
    this.load();
  }
  /**
   * 미방송 항목 반환 + seen 등록. commentary는 sequence 오름차순이 원본 순서다
   * (clock 없는 항목의 minuteNum=0이 맨 앞으로 점프하는 정렬 버그 방지 — 760415 실측).
   * commentary↔keyEvents 소스가 플립되면 id 체계(seq:/ke:)가 달라 전체가 fresh로 보이므로,
   * 그 배치는 통째로 흡수(absorb)해 경기 전체 재방송을 막는다.
   */
  takeNew(items, source) {
    const flipped = this.lastSource !== null && source !== null && this.lastSource !== source;
    this.lastSource = source ?? this.lastSource;
    const fresh = items.filter((it) => !this.seen.has(it.id));
    for (const it of fresh) this.seen.add(it.id);
    if (flipped) return [];
    fresh.sort((a, b) => {
      const sa = seqOf(a.id);
      const sb = seqOf(b.id);
      if (sa !== null && sb !== null) return sa - sb;
      return (a.minuteNum || 9999) - (b.minuteNum || 9999);
    });
    return fresh;
  }
  /** commentary 항목 없이 '중계된 적 없는' 스코어로 바뀐 경우 감지 (keyEvents-only 매치 보강) */
  scoreChanged(home, away) {
    return home !== this.lastHomeScore || away !== this.lastAwayScore;
  }
  /** 이 스코어가 이미 중계(합성 또는 실제 골)됐는가 — 이중 중계 억제 */
  isAnnounced(home, away) {
    return home === this.announcedHome && away === this.announcedAway;
  }
  markAnnounced(home, away) {
    this.announcedHome = home;
    this.announcedAway = away;
    this.save();
  }
  addHighlight(e) {
    this.highlights.push(e);
    this.save();
  }
  update(state, home, away) {
    this.lastState = state;
    this.lastHomeScore = home;
    this.lastAwayScore = away;
    this.save();
  }
  markKickoff() {
    this.kickoffAnnounced = true;
    this.save();
  }
  markHalftime() {
    this.halftimeAnnounced = true;
    this.save();
  }
  markFulltime() {
    if (this.fulltimeAnnounced) return false;
    this.fulltimeAnnounced = true;
    this.save();
    return true;
  }
  load() {
    try {
      const p = JSON.parse(fs5.readFileSync(this.statePath, "utf8"));
      this.seen = new Set(p.seenIds);
      this.lastState = p.lastState;
      this.lastHomeScore = p.lastHomeScore;
      this.lastAwayScore = p.lastAwayScore;
      this.announcedHome = p.announcedHome ?? 0;
      this.announcedAway = p.announcedAway ?? 0;
      this.kickoffAnnounced = p.kickoffAnnounced;
      this.halftimeAnnounced = p.halftimeAnnounced;
      this.fulltimeAnnounced = p.fulltimeAnnounced ?? false;
      this.lastSource = p.lastSource ?? null;
      this.highlights = Array.isArray(p.highlights) ? p.highlights : [];
    } catch {
    }
  }
  save() {
    const p = {
      seenIds: [...this.seen],
      lastState: this.lastState,
      lastHomeScore: this.lastHomeScore,
      lastAwayScore: this.lastAwayScore,
      announcedHome: this.announcedHome,
      announcedAway: this.announcedAway,
      kickoffAnnounced: this.kickoffAnnounced,
      halftimeAnnounced: this.halftimeAnnounced,
      fulltimeAnnounced: this.fulltimeAnnounced,
      lastSource: this.lastSource,
      highlights: this.highlights
    };
    try {
      fs5.writeFileSync(this.statePath + ".tmp", JSON.stringify(p));
      fs5.renameSync(this.statePath + ".tmp", this.statePath);
    } catch {
    }
  }
  /** 경기 종료 후 상태 파일 정리 */
  cleanup() {
    try {
      fs5.unlinkSync(this.statePath);
    } catch {
    }
  }
};
function seqOf(id) {
  if (!id.startsWith("seq:")) return null;
  const n = Number(id.slice(4));
  return Number.isFinite(n) ? n : null;
}
function acquireLock(logDir, matchId) {
  fs5.mkdirSync(logDir, { recursive: true });
  const lockPath = path5.join(logDir, `daemon-${matchId}.lock`);
  const tryWrite = () => {
    try {
      fs5.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  };
  if (!tryWrite()) {
    let owner = NaN;
    try {
      owner = Number(fs5.readFileSync(lockPath, "utf8"));
    } catch {
    }
    if (Number.isFinite(owner) && owner > 0 && isAlive(owner)) return { ok: false, pid: owner };
    try {
      fs5.unlinkSync(lockPath);
    } catch {
    }
    if (!tryWrite()) return { ok: false, pid: -1 };
  }
  return {
    ok: true,
    release: () => {
      try {
        fs5.unlinkSync(lockPath);
      } catch {
      }
    }
  };
}
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// src/tier.ts
var NOISE_TYPE_IDS = /* @__PURE__ */ new Set([
  "118",
  // Pass
  "177",
  // Ball touch
  "176",
  // Out
  "63",
  // Clear
  "178",
  // Take On
  "181",
  // Aerial
  "148",
  // Tackle
  "182",
  // Attempted tackle
  "65",
  // Cross
  "196",
  // Dispossessed
  "179",
  // Interception
  "141",
  // Assists Shot
  "110",
  // Goal Kick
  "162",
  // Blocked Pass
  "77",
  // Save (템플릿 텍스트 — 유의미한 선방은 106 Shot On Target 텍스트에 실림)
  "185",
  // Drop of Ball
  "180",
  // Claim
  "78",
  // Assist
  "202",
  // Keeper Sweeper
  "195",
  // Punch
  "200",
  // Shield ball opp
  "96",
  // Free Kick (실행 노이즈 — 선언은 66 Foul 텍스트가 커버)
  "124"
  // Throw In
]);
var CHANCE_TYPE_IDS = /* @__PURE__ */ new Set(["106", "117", "135", "136"]);
function ruleFor(item) {
  const t = item.typeText;
  const text = item.text;
  if (item.typeId === "80" || /^Kickoff$/i.test(t)) return { category: "kickoff", tier: 2 };
  if (item.typeId === "81" || /^First Half ends/i.test(text)) return { category: "halftime", tier: 2 };
  if (item.typeId === "82" || /^Second Half begins/i.test(text)) return { category: "resume", tier: 2 };
  if (item.typeId === "83" || /^Match ends/i.test(text) || /^Second Half ends/i.test(text)) {
    return { category: "fulltime", tier: 2 };
  }
  if (NOISE_TYPE_IDS.has(item.typeId)) return { category: "generic", tier: 0 };
  if (/^Goal kick/i.test(t)) return { category: "generic", tier: 0 };
  if (/^Goal\b/i.test(t) || /^Own Goal/i.test(t) || /^Goal!/i.test(text) || item.scoringPlay) {
    return { category: "goal", tier: 2 };
  }
  if (/penalty/i.test(t) || /penalty/i.test(text)) {
    return { category: "penalty", tier: 2 };
  }
  if (/^VAR/i.test(t) || /^VAR/i.test(text)) return { category: "var", tier: 2 };
  if (item.typeId === "93" || /red card/i.test(text)) return { category: "red", tier: 2 };
  if (item.typeId === "94" || /yellow card/i.test(text)) return { category: "yellow", tier: 1 };
  if (item.typeId === "76" || /^Substitution/i.test(text)) return { category: "sub", tier: 1 };
  if (CHANCE_TYPE_IDS.has(item.typeId)) return { category: "chance", tier: 1 };
  if (item.typeId === "95") return { category: "setpiece", tier: 1 };
  if (item.typeId === "66" || item.typeId === "68" || item.typeId === "122") return { category: "generic", tier: 1 };
  if (item.typeId === "129" || item.typeId === "130") return { category: "generic", tier: 1 };
  if (/\) [A-Za-z ]+ at \d+'$/.test(text)) return { category: "generic", tier: 0 };
  return { category: "generic", tier: 1 };
}
function classify(item, config) {
  const base = ruleFor(item);
  let tier = base.tier;
  if (tier === 1 && config.tier2.typeIds.includes(item.typeId)) tier = 2;
  return {
    id: item.id,
    category: base.category,
    tier,
    minuteNum: item.minuteNum,
    minute: item.minute || `${item.minuteNum}'`,
    rawText: item.text,
    typeId: item.typeId,
    typeText: item.typeText,
    player: item.player,
    teamAbbr: item.teamAbbr
  };
}
function isEndgameClose(snap, config) {
  return snap.state === "in" && snap.minuteNum >= config.tier2.lateGameMinute && Math.abs(snap.homeScore - snap.awayScore) <= config.tier2.closeScoreDiff;
}

// src/daemon.ts
var REPLAY_CATEGORIES = /* @__PURE__ */ new Set(["goal", "penalty", "var", "red"]);
var MAX_INFLIGHT_REPLAYS = 2;
var STREAM_GAP_MS = 600;
var IDLE_INTERVAL_SEC = 30;
var CATCHUP_THRESHOLD = 12;
async function runDaemon(eventId, opts = {}) {
  const config = loadConfig(opts.configPath);
  if (opts.league) config.league = opts.league;
  const skin = resolveSkin(config, process.cwd());
  const lock = acquireLock(config.logDir, eventId);
  if (!lock.ok) {
    process.stderr.write(`[e2e-monitor] match ${eventId}\uC740 \uC774\uBBF8 \uB370\uBAAC(pid ${lock.pid})\uC774 \uCD94\uC801 \uC911
`);
    return;
  }
  const logger = new MatchLogger(config.logDir, eventId, skin.wrapIndent);
  const state = new MatchStateStore(config.logDir, eventId);
  const narrator = new Narrator(config);
  logger.clearDone();
  logger.markWriter();
  process.stdout.write(
    `[e2e-monitor] \uB370\uBAAC \uAC00\uB3D9 \u2014 match ${eventId}, skin ${skin.name}
[e2e-monitor] \uD130\uBBF8\uB110 \uC2DC\uCCAD: tail -f ${logger.logPath}
`
  );
  const pendingReplays = /* @__PURE__ */ new Set();
  let celebration = Promise.resolve();
  let fastUntil = 0;
  let errStreak = 0;
  let primed = state.kickoffAnnounced;
  const enqueueReplay = (event, snap) => {
    if (pendingReplays.size >= MAX_INFLIGHT_REPLAYS) return;
    const p = narrator.narrateOne(event, skin).then((desc) => {
      if (!desc) return;
      const line = renderReplay(event, snap, skin, desc);
      if (line) logger.line(line);
    }).catch(() => {
    }).finally(() => pendingReplays.delete(p));
    pendingReplays.add(p);
  };
  try {
    for (; ; ) {
      const t0 = Date.now();
      const res = await fetchSummary(config.league, eventId);
      if (!res.ok) {
        logger.raw("fetch-error", { error: res.error, rawBody: res.rawBody });
        errStreak++;
        const backoff = Math.min(60, config.pollIntervalSec * 2 ** Math.min(errStreak, 3));
        await sleep(backoff * 1e3);
        continue;
      }
      errStreak = 0;
      const snap = res.data;
      let finished = false;
      try {
        finished = await processTick(snap);
      } catch (e) {
        logger.raw("tick-error", { error: e instanceof Error ? e.stack ?? e.message : String(e) });
      }
      if (finished || opts.once) return;
      const idle = snap.state === "pre" || snap.statusDetail === "HT";
      const intervalSec = idle ? IDLE_INTERVAL_SEC : isEndgameClose(snap, config) || Date.now() < fastUntil ? config.tier2PollIntervalSec : config.pollIntervalSec;
      await sleepRemainder(t0, intervalSec);
    }
  } finally {
    logger.clearWriter();
    lock.release();
  }
  async function processTick(snap) {
    const fresh = state.takeNew(snap.items, snap.keyEventsOnly ? "ke" : "seq");
    let events = fresh.map((i) => classify(i, config)).filter((e) => e.tier > 0);
    if (snap.state === "pre") {
      state.update(snap.state, snap.homeScore, snap.awayScore);
      return false;
    }
    if (!primed && events.length > CATCHUP_THRESHOLD) {
      await catchUp(events, snap, skin, logger, state);
      primed = true;
      state.markAnnounced(snap.homeScore, snap.awayScore);
      state.update(snap.state, snap.homeScore, snap.awayScore);
      return false;
    }
    primed = true;
    if (snap.state === "in" && !state.kickoffAnnounced && !events.some((e) => e.category === "kickoff")) {
      events.unshift(syntheticEvent("kickoff", snap, ""));
    }
    if (state.lastState !== "unknown" && state.scoreChanged(snap.homeScore, snap.awayScore) && !state.isAnnounced(snap.homeScore, snap.awayScore) && !events.some((e) => e.category === "goal")) {
      const scoreIncreased = snap.homeScore > state.lastHomeScore || snap.awayScore > state.lastAwayScore;
      if (scoreIncreased) {
        const scorer = snap.homeScore > state.lastHomeScore ? snap.homeAbbr : snap.awayAbbr;
        events.push(syntheticEvent("goal", snap, scorer));
      } else {
        events.push(syntheticEvent("var", snap, ""));
      }
    }
    const endgame = isEndgameClose(snap, config);
    const tier2Events = events.filter((e) => e.tier === 2 || endgame && e.tier >= 1);
    const tier1Events = events.filter((e) => !tier2Events.includes(e));
    let goalScored = false;
    for (const e of tier2Events) {
      if (e.category === "kickoff") {
        if (state.kickoffAnnounced) continue;
        state.markKickoff();
      }
      if (e.category === "halftime") {
        if (state.halftimeAnnounced) continue;
        state.markHalftime();
      }
      if (e.category === "fulltime" && !state.markFulltime()) continue;
      if (e.category === "goal") {
        const s = parseScoreFromGoalText(e.rawText, snap);
        if (s && state.isAnnounced(s.home, s.away)) continue;
        state.markAnnounced(s?.home ?? snap.homeScore, s?.away ?? snap.awayScore);
        goalScored = true;
      }
      await logger.stream(renderEvent(e, snap, skin), STREAM_GAP_MS);
      if (REPLAY_CATEGORIES.has(e.category)) {
        if (e.category === "goal" || e.category === "red") state.addHighlight(e);
        enqueueReplay(e, snap);
        fastUntil = Date.now() + config.tier2.cooldownSec * 1e3;
      }
    }
    if (tier1Events.length > 0) {
      const fastNow = endgame || Date.now() < fastUntil;
      let descs = null;
      if (!fastNow) {
        descs = await narrator.narrateBatch(tier1Events, skin).catch(() => null);
      }
      for (let i = 0; i < tier1Events.length; i++) {
        for (const line of renderEvent(tier1Events[i], snap, skin, descs?.[i])) logger.line(line);
      }
    }
    if (goalScored && config.goalAnimation) {
      const prev = celebration;
      const next = celebrateGoal(logger).catch(() => {
      });
      celebration = Promise.allSettled([prev, next]).then(() => {
      });
    }
    state.update(snap.state, snap.homeScore, snap.awayScore);
    if (snap.state === "post") {
      await Promise.race([Promise.allSettled([...pendingReplays, celebration]), sleep(15e3)]);
      await logger.stream(renderFinalReport(snap, state.highlights.slice(0, 20), skin), 300);
      logger.markDone();
      state.cleanup();
      process.stdout.write(`[e2e-monitor] match ${eventId} \uC885\uB8CC \u2014 \uB370\uBAAC \uC790\uC9C4 \uC885\uB8CC
`);
      return true;
    }
    return false;
  }
}
async function catchUp(events, snap, skin, logger, state) {
  const kickoff = events.find((e) => e.category === "kickoff") ?? syntheticEvent("kickoff", snap, "");
  await logger.stream(renderEvent(kickoff, snap, skin), STREAM_GAP_MS);
  state.markKickoff();
  for (const e of events) {
    if (e.category === "goal" || e.category === "red" || e.category === "penalty") {
      await logger.stream(renderEvent(e, snap, skin), STREAM_GAP_MS);
      if (e.category !== "penalty") state.addHighlight(e);
    }
  }
  if (snap.statusDetail === "HT") {
    const ht = events.find((e) => e.category === "halftime") ?? syntheticEvent("halftime", snap, "");
    await logger.stream(renderEvent(ht, snap, skin), STREAM_GAP_MS);
  }
  if (events.some((e) => e.category === "halftime")) state.markHalftime();
}
function syntheticEvent(category, snap, teamAbbr) {
  return {
    id: `synthetic:${category}:${snap.minuteNum}:${snap.homeScore}-${snap.awayScore}`,
    category,
    tier: 2,
    minuteNum: snap.minuteNum,
    minute: `${snap.minuteNum}'`,
    teamAbbr: teamAbbr || void 0,
    rawText: category === "goal" ? `Score change \u2192 ${snap.homeAbbr} ${snap.homeScore} : ${snap.awayScore} ${snap.awayAbbr}` : category === "var" ? `Score revised \u2192 ${snap.homeAbbr} ${snap.homeScore} : ${snap.awayScore} ${snap.awayAbbr}` : category
  };
}
async function sleepRemainder(t0, intervalSec) {
  await sleep(Math.max(250, intervalSec * 1e3 - (Date.now() - t0)));
}

// src/follow.ts
import fs6 from "node:fs";
var POLL_MS = 300;
var QUIET_MS = 2500;
var MAX_COLLECT_MS = 2e4;
var MAX_WAIT_SEC = 75;
var DEFAULT_WAIT_SEC = 60;
var STALE_DONE_GRACE_MS = 8e3;
async function runFollow(eventId, opts = {}) {
  const config = loadConfig(opts.configPath);
  const logPath = matchLogPath(config.logDir, eventId);
  const donePath = matchDonePath(config.logDir, eventId);
  const pidPath = writerPidPath(config.logDir, eventId);
  let cursor = Math.max(0, Math.trunc(Number(opts.cursor) || 0));
  const waitSec = Math.min(MAX_WAIT_SEC, Math.max(5, Math.trunc(Number(opts.waitSec) || DEFAULT_WAIT_SEC)));
  const deadline = Date.now() + waitSec * 1e3;
  const sizeOf = () => {
    try {
      return fs6.statSync(logPath).size;
    } catch {
      return -1;
    }
  };
  const doneExists = () => fs6.existsSync(donePath);
  if (cursor === 0 && doneExists()) {
    const size0 = sizeOf();
    const graceUntil = Date.now() + Math.min(STALE_DONE_GRACE_MS, waitSec * 1e3);
    while (Date.now() < graceUntil && doneExists() && sizeOf() === size0) {
      await sleep(POLL_MS);
    }
    if (doneExists() && sizeOf() === size0) {
      emitMarker(Math.max(0, size0), "done");
      return;
    }
  }
  for (; ; ) {
    const size2 = sizeOf();
    if (size2 >= 0 && size2 < cursor) cursor = 0;
    if (size2 > cursor) break;
    if (size2 >= 0 && cursor >= size2 && doneExists()) {
      emitMarker(cursor, "done");
      return;
    }
    if (Date.now() > deadline) {
      emitMarker(cursor, writerAlive(pidPath) ? "idle" : "stalled");
      return;
    }
    await sleep(POLL_MS);
  }
  const collectStart = Date.now();
  let lastGrow = Date.now();
  let size = sizeOf();
  for (; ; ) {
    if (Date.now() - lastGrow >= QUIET_MS) break;
    if (Date.now() - collectStart >= MAX_COLLECT_MS) break;
    await sleep(POLL_MS);
    const s = sizeOf();
    if (s > size) {
      size = s;
      lastGrow = Date.now();
    }
  }
  const chunk = readRange(logPath, cursor, size);
  const lastNl = chunk.lastIndexOf(10);
  if (lastNl < 0) {
    emitMarker(cursor, writerAlive(pidPath) ? "idle" : "stalled");
    return;
  }
  const newCursor = cursor + lastNl + 1;
  const text = stripAnsi(chunk.subarray(0, lastNl + 1).toString("utf8"));
  process.stdout.write(text);
  emitMarker(newCursor, doneExists() && newCursor >= sizeOf() ? "done" : "live");
}
function emitMarker(cursor, status) {
  process.stdout.write(`[follow] cursor=${cursor} ${status}
`);
}
function readRange(logPath, from, to) {
  if (to <= from) return Buffer.alloc(0);
  let fd = null;
  try {
    fd = fs6.openSync(logPath, "r");
    const buf = Buffer.alloc(to - from);
    const n = fs6.readSync(fd, buf, 0, buf.length, from);
    return buf.subarray(0, Math.max(0, n));
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== null) {
      try {
        fs6.closeSync(fd);
      } catch {
      }
    }
  }
}
function writerAlive(pidPath) {
  try {
    const pid = Number(fs6.readFileSync(pidPath, "utf8").trim());
    if (!Number.isFinite(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

// src/replay.ts
import fs7 from "node:fs";
var STREAM_GAP_MS2 = 600;
var MIN_GAP_MS = 700;
var MAX_GAP_MS = 25e3;
async function runReplay(eventId, opts = {}) {
  const config = loadConfig(opts.configPath);
  if (opts.league) config.league = opts.league;
  const speed = Math.max(1, Number(opts.speed) || 15);
  const skin = resolveSkin(config, process.cwd());
  const logger = new MatchLogger(config.logDir, eventId, skin.wrapIndent);
  const narrator = new Narrator(config);
  logger.clearDone();
  logger.markWriter();
  try {
    await runReplayBody(eventId, config, speed, skin, logger, narrator);
  } finally {
    logger.clearWriter();
  }
}
async function runReplayBody(eventId, config, speed, skin, logger, narrator) {
  const res = await fetchSummary(config.league, eventId);
  if (!res.ok) {
    process.stderr.write(`[e2e-monitor] summary \uC2E4\uD328: ${res.error}
`);
    process.exitCode = 1;
    return;
  }
  const snap = res.data;
  if (snap.state !== "post") {
    process.stderr.write(
      `[e2e-monitor] match ${eventId}\uB294 \uC544\uC9C1 ${snap.state} \u2014 replay\uB294 \uB05D\uB09C \uACBD\uAE30 \uC804\uC6A9, \uB77C\uC774\uBE0C\uB294 daemon\uC744 \uC4F0\uC790
`
    );
    process.exitCode = 1;
    return;
  }
  try {
    fs7.writeFileSync(logger.logPath, "");
  } catch {
  }
  const events = snap.items.map((i) => classify(i, config)).filter((e) => e.tier > 0);
  process.stdout.write(
    `[e2e-monitor] \uB9AC\uD50C\uB808\uC774 \uC2DC\uC791 \u2014 match ${eventId} (${snap.homeAbbr} ${snap.homeScore}:${snap.awayScore} ${snap.awayAbbr}), x${speed}, ~${Math.ceil(95 / speed * 10) / 10}\uBD84 \uC608\uC0C1
[e2e-monitor] \uD130\uBBF8\uB110 \uC2DC\uCCAD: tail -f ${logger.logPath}
`
  );
  const running = { ...snap, homeScore: 0, awayScore: 0 };
  const highlights = [];
  const pendingReplays = [];
  let prevMinute = 0;
  const kickoff = {
    id: "replay:kickoff",
    category: "kickoff",
    tier: 2,
    minuteNum: 0,
    minute: "0'",
    rawText: "kickoff"
  };
  await logger.stream(renderEvent(kickoff, running, skin), STREAM_GAP_MS2);
  let halftimeDone = false;
  let fulltimeDone = false;
  for (const e of events) {
    if (e.category === "kickoff") continue;
    if (e.minuteNum === 0 && e.category === "generic") continue;
    if (e.category === "halftime") {
      if (halftimeDone) continue;
      halftimeDone = true;
    }
    if (e.category === "fulltime") {
      if (fulltimeDone) continue;
      fulltimeDone = true;
    }
    const gap = Math.max(MIN_GAP_MS, Math.min(MAX_GAP_MS, (e.minuteNum - prevMinute) * (6e4 / speed)));
    await sleep(gap);
    prevMinute = Math.max(prevMinute, e.minuteNum);
    if (e.category === "goal") {
      bumpScore(running, e);
      highlights.push(e);
    }
    if (e.category === "red") highlights.push(e);
    if (e.tier === 2) {
      await logger.stream(renderEvent(e, running, skin), STREAM_GAP_MS2);
      if (e.category === "goal" && config.goalAnimation) {
        await celebrateGoal(logger).catch(() => {
        });
      }
      if ((e.category === "goal" || e.category === "red") && pendingReplays.length < 2) {
        const snapAt = { ...running };
        pendingReplays.push(
          narrator.narrateOne(e, skin).then((desc) => {
            if (!desc) return;
            const line = renderReplay(e, snapAt, skin, desc);
            if (line) logger.line(line);
          }).catch(() => {
          })
        );
      }
    } else {
      for (const line of renderEvent(e, running, skin)) logger.line(line);
    }
  }
  await Promise.race([Promise.allSettled(pendingReplays), sleep(15e3)]);
  await logger.stream(renderFinalReport(snap, highlights.slice(0, 20), skin), 300);
  logger.markDone();
  process.stdout.write(`[e2e-monitor] \uB9AC\uD50C\uB808\uC774 \uC885\uB8CC \u2014 ${snap.homeAbbr} ${snap.homeScore}:${snap.awayScore} ${snap.awayAbbr}
`);
}
function bumpScore(running, e) {
  const m = /Goal!\s+(.+?)\s+(\d+)[,:]\s+(.+?)\s+(\d+)\./.exec(e.rawText);
  if (m) {
    const assign = (name, score) => {
      if (overlaps(name, running.homeTeam)) running.homeScore = score;
      else if (overlaps(name, running.awayTeam)) running.awayScore = score;
    };
    assign(m[1], Number(m[2]));
    assign(m[3], Number(m[4]));
    return;
  }
  if (e.teamAbbr === running.homeAbbr) running.homeScore++;
  else if (e.teamAbbr === running.awayAbbr) running.awayScore++;
}
function overlaps(a, b) {
  const tokens = (s) => new Set(s.toLowerCase().split(/\s+/).filter((t) => t.length > 3));
  const ta = tokens(a);
  for (const t of tokens(b)) if (ta.has(t)) return true;
  return false;
}

// scripts/poll.ts
var USAGE = `e2e-monitor \u2014 \uC804\uBC18\uC804\uBD80\uD130 \uD6C4\uBC18\uC804\uAE4C\uC9C0, \uB2F9\uC2E0\uC758 \uD130\uBBF8\uB110\uC740 \uC77C\uD558\uACE0 \uC788\uC5C8\uC2B5\uB2C8\uB2E4.

\uC0AC\uC6A9\uBC95:
  npx tsx scripts/poll.ts list [--league <code>]          \uC624\uB298 \uACBD\uAE30 \uBAA9\uB85D
  npx tsx scripts/poll.ts daemon <eventId> [\uC635\uC158] &        \uB370\uBAAC \uC2DC\uC791 (\uACBD\uAE30 \uC885\uB8CC \uC2DC \uC790\uC9C4 \uC885\uB8CC)
  npx tsx scripts/poll.ts replay <eventId> [\uC635\uC158] &        \uB05D\uB09C \uACBD\uAE30\uB97C \uAC00\uC9DC \uB77C\uC774\uBE0C\uB85C \uC555\uCD95 \uC7AC\uC0DD
  npx tsx scripts/poll.ts follow <eventId> [\uC635\uC158]          \uC0C8 \uC911\uACC4 \uB77C\uC778 long-poll 1\uD68C\uBD84
                                                          (\uB9C8\uC9C0\uB9C9 \uC904 \uB9C8\uCEE4: [follow] cursor=<n> <status>)

\uC635\uC158:
  --league <code>   \uB9AC\uADF8 \uCF54\uB4DC (\uAE30\uBCF8 fifa.world)
  --config <path>   config.json \uACBD\uB85C (\uAE30\uBCF8 ~/.e2e-monitor/config.json)
  --once            1 tick\uB9CC \uC2E4\uD589 (\uAC80\uC99D\uC6A9, daemon \uC804\uC6A9)
  --speed <n>       replay \uC555\uCD95 \uBC30\uC728 (\uAE30\uBCF8 15 \u2014 90\uBD84 \uACBD\uAE30\uB97C ~6\uBD84\uC5D0)
  --cursor <byte>   follow \uC2DC\uC791 \uC704\uCE58 (\uC9C1\uC804 \uB9C8\uCEE4\uC758 cursor \uAC12, \uAE30\uBCF8 0)
  --wait <sec>      follow \uC0C8 \uB370\uC774\uD130 \uB300\uAE30 \uD55C\uB3C4 (\uAE30\uBCF8 60, \uC0C1\uD55C 75)

\uD130\uBBF8\uB110\uC5D0\uC11C \uC9C1\uC811 \uBCF4\uB824\uBA74:
  tail -f ~/.e2e-monitor/match-<eventId>.log
`;
async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : void 0;
  };
  if (cmd === "list") {
    const config = loadConfig(flag("config"));
    const league = flag("league") ?? config.league;
    const res = await fetchScoreboard(league);
    if (!res.ok) {
      process.stderr.write(`scoreboard \uC2E4\uD328: ${res.error}
`);
      return 1;
    }
    if (res.data.length === 0) {
      process.stdout.write(`\uC624\uB298(${league}) \uACBD\uAE30 \uC5C6\uC74C
`);
      return 0;
    }
    for (const e of res.data) {
      const score = e.state === "pre" ? "vs" : `${e.homeScore} : ${e.awayScore}`;
      process.stdout.write(
        `${e.id}  ${e.home.padEnd(4)} ${score.padStart(5)}  ${e.away.padEnd(4)} [${e.state}] ${e.detail}
`
      );
    }
    return 0;
  }
  if (cmd === "follow") {
    const eventId = argv[1];
    if (!eventId || eventId.startsWith("--")) {
      process.stderr.write(USAGE);
      return 1;
    }
    await runFollow(eventId, {
      configPath: flag("config"),
      cursor: Number(flag("cursor")) || 0,
      waitSec: Number(flag("wait")) || void 0
    });
    return 0;
  }
  if (cmd === "daemon" || cmd === "replay") {
    const eventId = argv[1];
    if (!eventId || eventId.startsWith("--")) {
      process.stderr.write(USAGE);
      return 1;
    }
    if (cmd === "replay") {
      await runReplay(eventId, {
        league: flag("league"),
        configPath: flag("config"),
        speed: Number(flag("speed")) || void 0
      });
      return Number(process.exitCode ?? 0);
    }
    await runDaemon(eventId, {
      league: flag("league"),
      configPath: flag("config"),
      once: argv.includes("--once")
    });
    return 0;
  }
  process.stderr.write(USAGE);
  return cmd === void 0 || cmd === "help" || cmd === "--help" ? 0 : 1;
}
main().then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(`[e2e-monitor] fatal: ${e?.stack ?? e}
`);
  process.exit(1);
});
