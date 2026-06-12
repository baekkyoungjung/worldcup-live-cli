import { celebrateGoal } from './celebrate.js';
import { loadConfig } from './config.js';
import { fetchSummary } from './espn.js';
import { MatchLogger, sleep } from './logger.js';
import { Narrator } from './narrate.js';
import { parseScoreFromGoalText, renderEvent, renderFinalReport, renderReplay } from './render.js';
import { resolveSkin } from './skin.js';
import { acquireLock, MatchStateStore } from './state.js';
import { classify, isEndgameClose } from './tier.js';
import type { MatchEvent, MatchSnapshot, Skin } from './types.js';

const REPLAY_CATEGORIES = new Set(['goal', 'penalty', 'var', 'red']);
const MAX_INFLIGHT_REPLAYS = 2;
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
  const skin = resolveSkin(config, process.cwd());

  // 같은 경기에 데몬 둘이 붙으면 로그 중복·state 경쟁 — 두 번째는 정중히 거절
  const lock = acquireLock(config.logDir, eventId);
  if (!lock.ok) {
    process.stderr.write(`[e2e-monitor] match ${eventId}은 이미 데몬(pid ${lock.pid})이 추적 중\n`);
    return;
  }

  const logger = new MatchLogger(config.logDir, eventId, skin.wrapIndent);
  const state = new MatchStateStore(config.logDir, eventId);
  const narrator = new Narrator(config);

  // follow 소비자를 위한 마커: 이전 회차의 done은 지우고, 내가 writer임을 알린다
  logger.clearDone();
  logger.markWriter();

  process.stdout.write(
    `[e2e-monitor] 데몬 가동 — match ${eventId}, skin ${skin.name}\n` +
      `[e2e-monitor] 터미널 시청: tail -f ${logger.logPath}\n`,
  );

  const pendingReplays = new Set<Promise<void>>();
  let celebration: Promise<void> = Promise.resolve();
  let fastUntil = 0;
  let errStreak = 0;
  let primed = state.kickoffAnnounced; // 재시작 시엔 seen 셋이 있으니 캐치업 불필요

  const enqueueReplay = (event: MatchEvent, snap: MatchSnapshot) => {
    if (pendingReplays.size >= MAX_INFLIGHT_REPLAYS) return; // 몰리면 조용히 포기 — 침묵도 위장
    const p = narrator
      .narrateOne(event, skin)
      .then((desc) => {
        if (!desc) return;
        const line = renderReplay(event, snap, skin, desc);
        if (line) logger.line(line);
      })
      .catch(() => {})
      .finally(() => pendingReplays.delete(p));
    pendingReplays.add(p);
  };

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

      let finished = false;
      try {
        finished = await processTick(snap);
      } catch (e) {
        // tick 본문의 예상 못 한 throw 하나가 풀타임 중계를 끝장내선 안 된다
        logger.raw('tick-error', { error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
      }
      if (finished || opts.once) return;

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

  /** 한 tick의 본문. 경기가 끝나 데몬이 종료해야 하면 true */
  async function processTick(snap: MatchSnapshot): Promise<boolean> {
    const fresh = state.takeNew(snap.items, snap.keyEventsOnly ? 'ke' : 'seq');
    let events = fresh.map((i) => classify(i, config)).filter((e) => e.tier > 0);

    // 침묵도 위장: 킥오프 전 라인업·공지 commentary는 중계가 아니다 — seen 처리만 하고 버린다
    if (snap.state === 'pre') {
      state.update(snap.state, snap.homeScore, snap.awayScore);
      return false;
    }

    // 중반 합류: 전반전 전체를 재방송하면 위장도 가독성도 깨진다 — 캐치업 요약만
    if (!primed && events.length > CATCHUP_THRESHOLD) {
      await catchUp(events, snap, skin, logger, state);
      primed = true;
      state.markAnnounced(snap.homeScore, snap.awayScore);
      state.update(snap.state, snap.homeScore, snap.awayScore);
      return false;
    }
    primed = true;

    // 킥오프 합성 (keyEvents-only 매치 등 항목이 안 오는 경우)
    if (snap.state === 'in' && !state.kickoffAnnounced && !events.some((e) => e.category === 'kickoff')) {
      events.unshift(syntheticEvent('kickoff', snap, ''));
    }

    // 골 항목 없이 스코어만 움직인 경우(keyEvents 누락) — 단 이미 중계한 스코어면 침묵.
    // 헤더가 commentary보다 먼저/늦게 갱신되는 시차에서 같은 골을 두 번 떠들지 않기 위함.
    if (
      state.lastState !== 'unknown' &&
      state.scoreChanged(snap.homeScore, snap.awayScore) &&
      !state.isAnnounced(snap.homeScore, snap.awayScore) &&
      !events.some((e) => e.category === 'goal')
    ) {
      const scoreIncreased =
        snap.homeScore > state.lastHomeScore || snap.awayScore > state.lastAwayScore;
      if (scoreIncreased) {
        const scorer = snap.homeScore > state.lastHomeScore ? snap.homeAbbr : snap.awayAbbr;
        events.push(syntheticEvent('goal', snap, scorer));
      } else {
        // 스코어 감소 = VAR 골 취소 — 골이 아니라 정정 이벤트다
        events.push(syntheticEvent('var', snap, ''));
      }
    }

    const endgame = isEndgameClose(snap, config);
    const tier2Events = events.filter((e) => e.tier === 2 || (endgame && e.tier >= 1));
    const tier1Events = events.filter((e) => !tier2Events.includes(e));
    let goalScored = false;

    // tier-2: 실측상 claude -p(중앙값 ~11s)는 3s 주기를 못 따라온다.
    // 템플릿 즉시 출력이 우선, 각색은 replay 보강 라인으로 사후 합류 ([내부] 메모 ②)
    for (const e of tier2Events) {
      if (e.category === 'kickoff') {
        if (state.kickoffAnnounced) continue;
        state.markKickoff();
      }
      if (e.category === 'halftime') {
        if (state.halftimeAnnounced) continue;
        state.markHalftime();
      }
      if (e.category === 'fulltime' && !state.markFulltime()) continue; // FT 텍스트 변형 2종 중복 방지
      if (e.category === 'goal') {
        // 합성 골이 먼저 나갔던 스코어의 실제 골 항목이 뒤늦게 오면 억제
        const s = parseScoreFromGoalText(e.rawText, snap);
        if (s && state.isAnnounced(s.home, s.away)) continue;
        state.markAnnounced(s?.home ?? snap.homeScore, s?.away ?? snap.awayScore);
        goalScored = true;
      }
      await logger.stream(renderEvent(e, snap, skin), STREAM_GAP_MS);
      if (REPLAY_CATEGORIES.has(e.category)) {
        if (e.category === 'goal' || e.category === 'red') state.addHighlight(e);
        enqueueReplay(e, snap);
        fastUntil = Date.now() + config.tier2.cooldownSec * 1000;
      }
    }

    // tier-1: tick 묶음을 배치 1회로 각색. fast mode에선 3s 케이던스 보호를 위해 템플릿 직행.
    // (같은 tick에 골이 터졌으면 fastUntil이 방금 갱신됐다 — 여기서 다시 평가해야 25s 각색이 끼어들지 않는다)
    if (tier1Events.length > 0) {
      const fastNow = endgame || Date.now() < fastUntil;
      let descs: (string | null)[] | null = null;
      if (!fastNow) {
        descs = await narrator.narrateBatch(tier1Events, skin).catch(() => null);
      }
      for (let i = 0; i < tier1Events.length; i++) {
        for (const line of renderEvent(tier1Events[i], snap, skin, descs?.[i])) logger.line(line);
      }
    }

    // 골 애니메이션: tick의 정규 출력이 모두 끝난 뒤 fire-and-forget으로 시작 —
    // 10초 연출이 폴링 케이던스를 1ms도 밀어내지 않는다. 다음 tick의 라인이
    // 프레임 사이에 끼어들 수 있지만, 케이던스가 연출 순수성보다 우선이다.
    if (goalScored && config.goalAnimation) {
      // 덮어쓰지 않고 합류시킨다 — 재생 중 연속골(no-op 즉시 resolve)이 진행 중인
      // 애니메이션 추적을 끊으면 FT 직전 최종 보고가 잔여 프레임과 교차할 수 있다
      const prev = celebration;
      const next = celebrateGoal(logger).catch(() => {});
      celebration = Promise.allSettled([prev, next]).then(() => {});
    }

    state.update(snap.state, snap.homeScore, snap.awayScore);

    if (snap.state === 'post') {
      // 진행 중인 replay 각색·골 애니메이션을 잠깐 기다렸다가 최종 보고 후 자진 종료
      await Promise.race([Promise.allSettled([...pendingReplays, celebration]), sleep(15_000)]);
      await logger.stream(renderFinalReport(snap, state.highlights.slice(0, 20), skin), 300);
      // done은 반드시 최종 보고의 마지막 append 뒤에 — 먼저 찍으면 follow가 보고를 버리고 끝낸다
      logger.markDone();
      state.cleanup();
      process.stdout.write(`[e2e-monitor] match ${eventId} 종료 — 데몬 자진 종료\n`);
      return true;
    }
    return false;
  }
}

/** 중반 합류 캐치업: 킥오프 + 골/퇴장/PK 하이라이트만 템플릿으로, 나머지는 침묵 처리 */
async function catchUp(
  events: MatchEvent[],
  snap: MatchSnapshot,
  skin: Skin,
  logger: MatchLogger,
  state: MatchStateStore,
): Promise<void> {
  const kickoff = events.find((e) => e.category === 'kickoff') ?? syntheticEvent('kickoff', snap, '');
  await logger.stream(renderEvent(kickoff, snap, skin), STREAM_GAP_MS);
  state.markKickoff();

  for (const e of events) {
    if (e.category === 'goal' || e.category === 'red' || e.category === 'penalty') {
      await logger.stream(renderEvent(e, snap, skin), STREAM_GAP_MS);
      if (e.category !== 'penalty') state.addHighlight(e);
    }
  }
  if (snap.statusDetail === 'HT') {
    const ht = events.find((e) => e.category === 'halftime') ?? syntheticEvent('halftime', snap, '');
    await logger.stream(renderEvent(ht, snap, skin), STREAM_GAP_MS);
  }
  if (events.some((e) => e.category === 'halftime')) state.markHalftime();
}

function syntheticEvent(category: MatchEvent['category'], snap: MatchSnapshot, teamAbbr: string): MatchEvent {
  return {
    id: `synthetic:${category}:${snap.minuteNum}:${snap.homeScore}-${snap.awayScore}`,
    category,
    tier: 2,
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
