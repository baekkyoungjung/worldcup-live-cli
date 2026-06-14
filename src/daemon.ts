import { loadConfig } from './config.js';
import { fetchSummary } from './espn.js';
import { MatchLogger, sleep } from './logger.js';
import { Narrator } from './narrate.js';
import { parseScoreFromGoalText, renderAmbient, renderEventLines, renderFinalReport } from './render.js';
import { acquireLock, MatchStateStore } from './state.js';
import { classify, isEndgameClose, isHot } from './tier.js';
import type { Category, MatchEvent, MatchSnapshot, Severity } from './types.js';

const HOT_CATEGORIES = new Set<Category>(['goal', 'penalty', 'red', 'var']);
const STREAM_GAP_MS = 600;
const IDLE_INTERVAL_SEC = 30; // pre / HT — 새 이벤트가 없는 구간
const CATCHUP_THRESHOLD = 12; // 첫 tick에 이보다 많이 쌓여 있으면 중반 합류로 간주

export interface DaemonOptions {
  league?: string;
  configPath?: string;
  /** 1 tick만 돌고 종료 — 검증용 */
  once?: boolean;
}

export async function runDaemon(eventId: string, opts: DaemonOptions = {}): Promise<void> {
  const config = loadConfig(opts.configPath);
  if (opts.league) config.league = opts.league;

  // 같은 경기에 데몬 둘이 붙으면 로그 중복·state 경쟁 — 두 번째는 정중히 거절
  const lock = acquireLock(config.logDir, eventId);
  if (!lock.ok) {
    process.stderr.write(`[e2e-monitor] match ${eventId}은 이미 데몬(pid ${lock.pid})이 추적 중\n`);
    return;
  }

  const logger = new MatchLogger(config.logDir, eventId);
  const state = new MatchStateStore(config.logDir, eventId);
  const narrator = new Narrator(config);

  logger.clearDone();
  logger.markWriter();

  process.stdout.write(
    `[e2e-monitor] 데몬 가동 — match ${eventId}\n` +
      `[e2e-monitor] 터미널 시청: tail -f ${logger.logPath}\n`,
  );

  let fastUntil = 0;
  let errStreak = 0;
  let primed = state.kickoffAnnounced;
  let lastOutputAt = Date.now();

  try {
    for (;;) {
      const t0 = Date.now();
      const res = await fetchSummary(config.league, eventId);

      if (!res.ok) {
        // 비공식 API의 숙명 — 죽지 않고 raw를 사이드카에 남기며 버틴다
        logger.raw('fetch-error', { error: res.error, rawBody: res.rawBody });
        errStreak++;
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
        logger.line(renderAmbient());
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
      await catchUp(events, snap, logger, state);
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
      await logger.stream(renderEventLines(e, snap), STREAM_GAP_MS);
      emitted = true;
      if (e.category === 'goal' || e.category === 'red') state.addHighlight(e);
      if (isHot(e) || HOT_CATEGORIES.has(e.category)) fastUntil = Date.now() + config.tier2.cooldownSec * 1000;
    }

    // 흐름 이벤트: tick 묶음을 배치 1회로 각색. fast mode에선 케이던스 보호를 위해 템플릿 직행.
    if (batched.length > 0) {
      const fastNow = endgame || Date.now() < fastUntil;
      let descs: (string | null)[] | null = null;
      if (!fastNow) descs = await narrator.narrateBatch(batched, snap).catch(() => null);
      for (let i = 0; i < batched.length; i++) {
        for (const line of renderEventLines(batched[i], snap, descs?.[i])) {
          logger.line(line);
          emitted = true;
        }
      }
    }

    state.update(snap.state, snap.homeScore, snap.awayScore);

    if (snap.state === 'post') {
      await logger.stream(renderFinalReport(snap, state.highlights.slice(0, 20)), 300);
      logger.markDone();
      state.cleanup();
      process.stdout.write(`[e2e-monitor] match ${eventId} 종료 — 데몬 자진 종료\n`);
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
): Promise<void> {
  const kickoff = events.find((e) => e.category === 'kickoff') ?? syntheticEvent('kickoff', snap, '');
  await logger.stream(renderEventLines(kickoff, snap), STREAM_GAP_MS);
  state.markKickoff();

  for (const e of events) {
    if (e.category === 'goal' || e.category === 'red' || e.category === 'penalty') {
      await logger.stream(renderEventLines(e, snap), STREAM_GAP_MS);
      if (e.category !== 'penalty') state.addHighlight(e);
    }
  }
  if (snap.statusDetail === 'HT') {
    const ht = events.find((e) => e.category === 'halftime') ?? syntheticEvent('halftime', snap, '');
    await logger.stream(renderEventLines(ht, snap), STREAM_GAP_MS);
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
