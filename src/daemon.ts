import { loadConfig } from './config.js';
import { fetchSummary } from './espn.js';
import { MatchLogger, sleep } from './logger.js';
import { Narrator } from './narrate.js';
import { parseScoreFromGoalText, renderAmbient, renderEventLines, renderFinalReport } from './render.js';
import { acquireLock, MatchStateStore } from './state.js';
import { stringsFor, type Strings } from './strings.js';
import { classify, isEndgameClose, isHot } from './tier.js';
import type { Category, Language, MatchEvent, MatchSnapshot, Severity } from './types.js';

const HOT_CATEGORIES = new Set<Category>(['goal', 'penalty', 'red', 'var']);
const STREAM_GAP_MS = 600;
const IDLE_INTERVAL_SEC = 30; // pre / HT — 새 이벤트가 없는 구간
const CATCHUP_THRESHOLD = 12; // 첫 tick에 이보다 많이 쌓여 있으면 중반 합류로 간주

// ── 폭주 방지 안전 상한 (무한 루프·무한 토큰·무한 디스크의 구조적 차단) ──
// 'post'가 영영 안 오는 경기(중단·버려진 경기, state가 'in'/'pre'/'unknown'에 고착,
// API 영구 장애)에도 데몬이 자진 종료하도록 못박는다. 정상 경기는 이 상한에 닿지 않는다.
const MAX_RUNTIME_MS = 5 * 60 * 60 * 1000; // 5시간 — 연장·승부차기·지연을 다 합쳐도 경기는 이 안에 끝난다
const MAX_ERROR_STREAK = 20; // 연속 fetch 실패 한도 (capped 60s backoff면 ~20분) — 죽은 엔드포인트를 영원히 두드리지 않는다
const MAX_NARRATION_CALLS = 2000; // 데몬 1회 수명당 claude 호출 총량 상한 — 정상 경기치(수백)를 크게 상회. 초과 시 템플릿 직행

export interface DaemonOptions {
  league?: string;
  configPath?: string;
  /** 중계 출력 언어 — config보다 우선 */
  language?: Language;
  /** 1 tick만 돌고 종료 — 검증용 */
  once?: boolean;
}

export async function runDaemon(eventId: string, opts: DaemonOptions = {}): Promise<void> {
  const config = loadConfig(opts.configPath);
  if (opts.league) config.league = opts.league;
  if (opts.language) config.language = opts.language;

  // 같은 경기에 데몬 둘이 붙으면 로그 중복·state 경쟁 — 두 번째는 정중히 거절
  const lock = acquireLock(config.logDir, eventId);
  if (!lock.ok) {
    process.stderr.write(`[worldcup-live-cli] match ${eventId}은 이미 데몬(pid ${lock.pid})이 추적 중\n`);
    return;
  }

  const logger = new MatchLogger(config.logDir, eventId);
  const state = new MatchStateStore(config.logDir, eventId);
  const narrator = new Narrator(config);
  const strings = stringsFor(config.language);

  logger.clearDone();
  logger.markWriter();

  process.stdout.write(
    `[worldcup-live-cli] 데몬 가동 — match ${eventId}\n` +
      `[worldcup-live-cli] 터미널 시청: tail -f ${logger.logPath}\n`,
  );

  let fastUntil = 0;
  let errStreak = 0;
  let primed = state.kickoffAnnounced;
  let lastOutputAt = Date.now();
  const startedAt = Date.now();
  let narrationCalls = 0;

  // 안전 종료: 사유를 사이드카에 남기고 done 마커를 찍어 follow 루프를 깔끔히 끝낸다.
  // (markDone 없이 그냥 죽으면 follow가 'stalled'로 매달릴 수 있다.)
  const safeStop = (reason: string): void => {
    logger.raw('daemon-stop', { reason, runtimeMs: Date.now() - startedAt, narrationCalls });
    logger.markDone();
    process.stdout.write(`[worldcup-live-cli] match ${eventId} 안전 종료(${reason}) — 데몬 자진 종료\n`);
  };

  try {
    for (;;) {
      // 무한 실행 차단: 어떤 경기도 5시간을 넘기지 않는다 — 넘기면 비정상이므로 자진 종료
      if (Date.now() - startedAt > MAX_RUNTIME_MS) {
        safeStop('max-runtime');
        return;
      }
      const t0 = Date.now();
      const res = await fetchSummary(config.league, eventId);

      if (!res.ok) {
        // 비공식 API의 숙명 — 죽지 않고 raw를 사이드카에 남기며 버틴다
        logger.raw('fetch-error', { error: res.error, rawBody: res.rawBody });
        errStreak++;
        // 죽은 엔드포인트를 영원히 두드리지 않는다 — 연속 실패 한도 넘으면 자진 종료
        if (errStreak >= MAX_ERROR_STREAK) {
          safeStop('error-streak');
          return;
        }
        const backoff = Math.min(60, config.pollIntervalSec * 2 ** Math.min(errStreak, 3));
        await sleep(backoff * 1000);
        continue;
      }
      errStreak = 0;
      const snap = res.data;

      let result = { finished: false, emitted: false };
      try {
        result = await processTick(snap);
      } catch (e) {
        logger.raw('tick-error', { error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
      }
      if (result.emitted) lastOutputAt = Date.now();
      if (result.finished || opts.once) return;

      // 앰비언트: 인플레이 중 출력이 없는 구간이 ambientIntervalSec를 넘기면 한 줄 흘린다.
      // "10초 정적이면 좀 그렇지" — 침묵을 없애되 사실은 지어내지 않는다.
      const inPlay = snap.state === 'in' && snap.statusDetail !== 'HT';
      if (inPlay && !result.emitted && Date.now() - lastOutputAt >= config.ambientIntervalSec * 1000) {
        logger.line(renderAmbient(strings));
        lastOutputAt = Date.now();
      }

      const idle = snap.state === 'pre' || snap.statusDetail === 'HT';
      const intervalSec = idle
        ? IDLE_INTERVAL_SEC
        : isEndgameClose(snap, config) || Date.now() < fastUntil
          ? config.tier2PollIntervalSec
          : config.pollIntervalSec;
      await sleepRemainder(t0, intervalSec);
    }
  } finally {
    logger.clearWriter();
    lock.release();
  }

  /** 한 tick의 본문. 경기 종료 시 finished=true, 라인을 하나라도 썼으면 emitted=true */
  async function processTick(snap: MatchSnapshot): Promise<{ finished: boolean; emitted: boolean }> {
    const fresh = state.takeNew(snap.items, snap.keyEventsOnly ? 'ke' : 'seq');
    let events = fresh.map((i) => classify(i, config)).filter((e) => e.tier > 0);

    if (snap.state === 'pre') {
      state.update(snap.state, snap.homeScore, snap.awayScore);
      return { finished: false, emitted: false };
    }

    if (!primed && events.length > CATCHUP_THRESHOLD) {
      await catchUp(events, snap, logger, state, strings);
      primed = true;
      state.markAnnounced(snap.homeScore, snap.awayScore);
      state.update(snap.state, snap.homeScore, snap.awayScore);
      return { finished: false, emitted: true };
    }
    primed = true;

    if (snap.state === 'in' && !state.kickoffAnnounced && !events.some((e) => e.category === 'kickoff')) {
      events.unshift(syntheticEvent('kickoff', snap, ''));
    }

    // 골 항목 없이 스코어만 움직인 경우(keyEvents 누락) — 이미 중계한 스코어면 침묵
    if (
      state.lastState !== 'unknown' &&
      state.scoreChanged(snap.homeScore, snap.awayScore) &&
      !state.isAnnounced(snap.homeScore, snap.awayScore) &&
      !events.some((e) => e.category === 'goal')
    ) {
      const scoreIncreased = snap.homeScore > state.lastHomeScore || snap.awayScore > state.lastAwayScore;
      if (scoreIncreased) {
        const scorer = snap.homeScore > state.lastHomeScore ? snap.homeAbbr : snap.awayAbbr;
        events.push(syntheticEvent('goal', snap, scorer));
      } else {
        events.push(syntheticEvent('var', snap, '')); // 스코어 감소 = VAR 골 취소
      }
    }

    const endgame = isEndgameClose(snap, config);
    const immediate = events.filter((e) => e.tier === 2 || (endgame && e.tier >= 1));
    const batched = events.filter((e) => !immediate.includes(e));
    let emitted = false;

    // 즉시 출력군(tier-2/박빙): claude 각색을 기다리지 않고 템플릿으로 바로 — 케이던스 우선
    for (const e of immediate) {
      if (e.category === 'kickoff') {
        if (state.kickoffAnnounced) continue;
        state.markKickoff();
      }
      if (e.category === 'halftime') {
        if (state.halftimeAnnounced) continue;
        state.markHalftime();
      }
      if (e.category === 'fulltime' && !state.markFulltime()) continue;
      if (e.category === 'goal') {
        const s = parseScoreFromGoalText(e.rawText, snap);
        if (s && state.isAnnounced(s.home, s.away)) continue;
        state.markAnnounced(s?.home ?? snap.homeScore, s?.away ?? snap.awayScore);
      }
      await logger.stream(renderEventLines(e, snap, strings), STREAM_GAP_MS);
      emitted = true;
      if (e.category === 'goal' || e.category === 'red') state.addHighlight(e);
      if (isHot(e) || HOT_CATEGORIES.has(e.category)) fastUntil = Date.now() + config.tier2.cooldownSec * 1000;
    }

    // 흐름 이벤트: tick 묶음을 배치 1회로 각색. fast mode에선 케이던스 보호를 위해 템플릿 직행.
    if (batched.length > 0) {
      const fastNow = endgame || Date.now() < fastUntil;
      let descs: (string | null)[] | null = null;
      // 토큰 폭주 차단: claude 호출 총량이 상한을 넘으면 각색을 멈추고 템플릿으로만 간다.
      // 정상 경기는 상한 근처도 못 가지만, 이벤트가 끝없이 새로 들어오는 비정상 피드를 못 박는다.
      if (!fastNow && narrationCalls < MAX_NARRATION_CALLS) {
        narrationCalls++;
        descs = await narrator.narrateBatch(batched, snap).catch(() => null);
      }
      for (let i = 0; i < batched.length; i++) {
        for (const line of renderEventLines(batched[i], snap, strings, descs?.[i])) {
          logger.line(line);
          emitted = true;
        }
      }
    }

    state.update(snap.state, snap.homeScore, snap.awayScore);

    if (snap.state === 'post') {
      await logger.stream(renderFinalReport(snap, state.highlights.slice(0, 20), strings), 300);
      logger.markDone();
      state.cleanup();
      process.stdout.write(`[worldcup-live-cli] match ${eventId} 종료 — 데몬 자진 종료\n`);
      return { finished: true, emitted: true };
    }
    return { finished: false, emitted };
  }
}

/** 중반 합류 캐치업: 킥오프 + 골/퇴장/PK 하이라이트만, 나머지는 침묵 처리 */
async function catchUp(
  events: MatchEvent[],
  snap: MatchSnapshot,
  logger: MatchLogger,
  state: MatchStateStore,
  strings: Strings,
): Promise<void> {
  const kickoff = events.find((e) => e.category === 'kickoff') ?? syntheticEvent('kickoff', snap, '');
  await logger.stream(renderEventLines(kickoff, snap, strings), STREAM_GAP_MS);
  state.markKickoff();

  for (const e of events) {
    if (e.category === 'goal' || e.category === 'red' || e.category === 'penalty') {
      await logger.stream(renderEventLines(e, snap, strings), STREAM_GAP_MS);
      if (e.category !== 'penalty') state.addHighlight(e);
    }
  }
  if (snap.statusDetail === 'HT') {
    const ht = events.find((e) => e.category === 'halftime') ?? syntheticEvent('halftime', snap, '');
    await logger.stream(renderEventLines(ht, snap, strings), STREAM_GAP_MS);
  }
  if (events.some((e) => e.category === 'halftime')) state.markHalftime();
}

const SYNTH_SEVERITY: Partial<Record<Category, Severity>> = {
  goal: 'critical',
  var: 'warn',
  kickoff: 'log',
  halftime: 'log',
};

function syntheticEvent(category: Category, snap: MatchSnapshot, teamAbbr: string): MatchEvent {
  return {
    id: `synthetic:${category}:${snap.minuteNum}:${snap.homeScore}-${snap.awayScore}`,
    category,
    tier: 2,
    severity: SYNTH_SEVERITY[category] ?? 'log',
    minuteNum: snap.minuteNum,
    minute: `${snap.minuteNum}'`,
    teamAbbr: teamAbbr || undefined,
    rawText:
      category === 'goal'
        ? `Score change → ${snap.homeAbbr} ${snap.homeScore} : ${snap.awayScore} ${snap.awayAbbr}`
        : category === 'var'
          ? `Score revised → ${snap.homeAbbr} ${snap.homeScore} : ${snap.awayScore} ${snap.awayAbbr}`
          : category,
  };
}

async function sleepRemainder(t0: number, intervalSec: number): Promise<void> {
  await sleep(Math.max(250, intervalSec * 1000 - (Date.now() - t0)));
}
